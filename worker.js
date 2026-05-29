/**
 * CloudBreak — VLESS + VMess over WebSocket on Cloudflare Workers
 * Protocol: VLESS (RFC-ish) over WebSocket, TLS terminated by Cloudflare
 *
 * Environment variables:
 *   UUID        — VLESS authentication UUID (required)
 *   WS_PATH     — WebSocket endpoint path (default: "/ws")
 *   SUB_PATH    — Subscription endpoint path (default: random, set at deploy)
 *   PROXYIP     — Optional relay IP for chaining
 *   DEPLOY_TIME — Informational timestamp
 */

import { connect } from "cloudflare:sockets";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HEADER_SIZE   = 8192;   // bytes — reject oversized VLESS headers
const AUTH_TIMEOUT_MS   = 10_000; // ms   — close WS if no valid header arrives
const CONNECT_TIMEOUT_MS = 15_000; // ms  — TCP connect must complete within this

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UUID string → 16-byte Uint8Array. Throws on invalid input. */
function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`Invalid UUID: ${uuid}`);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Constant-time byte array comparison (avoids timing attacks). */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Safe base64 encode — handles non-Latin1 characters.
 * btoa() crashes on anything outside Latin-1 range.
 */
function safeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Parse the VLESS request header from a raw ArrayBuffer.
 *
 * Layout (version 0):
 *   [0]        version (0x00)
 *   [1..16]    UUID (16 bytes)
 *   [17]       addons length M
 *   [18..17+M] addons data (skipped)
 *   [18+M]     command (0x01 = TCP)
 *   [19+M,20+M] port (big-endian uint16)
 *   [21+M]     address type: 0x01=IPv4, 0x02=domain, 0x03=IPv6
 *   [...]      address bytes
 *   [rest]     initial payload
 *
 * Returns { uuid, command, port, address, payloadOffset } or throws.
 */
function parseVlessHeader(buf) {
  if (buf.byteLength < 19) throw new Error("Header too short");
  if (buf.byteLength > MAX_HEADER_SIZE) throw new Error("Header too large");

  const view   = new DataView(buf);
  let   offset = 0;

  const version = view.getUint8(offset++);
  if (version !== 0x00) throw new Error(`Unsupported VLESS version: ${version}`);

  const uuid = new Uint8Array(buf.slice(offset, offset + 16));
  offset += 16;

  const addonsLen = view.getUint8(offset++);
  if (offset + addonsLen > buf.byteLength) throw new Error("Addons overflow");
  offset += addonsLen;

  if (offset + 4 > buf.byteLength) throw new Error("Header truncated at command");
  const command = view.getUint8(offset++);
  const port    = view.getUint16(offset, false);
  offset += 2;

  const addrType = view.getUint8(offset++);
  let address;

  if (addrType === 0x01) {
    // IPv4 — 4 bytes
    if (offset + 4 > buf.byteLength) throw new Error("IPv4 truncated");
    address = `${view.getUint8(offset)}.${view.getUint8(offset+1)}.${view.getUint8(offset+2)}.${view.getUint8(offset+3)}`;
    offset += 4;

  } else if (addrType === 0x02) {
    // Domain name
    if (offset + 1 > buf.byteLength) throw new Error("Domain length byte missing");
    const domainLen = view.getUint8(offset++);
    if (domainLen === 0) throw new Error("Empty domain");
    if (offset + domainLen > buf.byteLength) throw new Error("Domain truncated");
    address = new TextDecoder().decode(new Uint8Array(buf, offset, domainLen));
    if (!/^[a-zA-Z0-9._\-\[\]:]+$/.test(address)) throw new Error(`Suspicious domain: ${address}`);
    offset += domainLen;

  } else if (addrType === 0x03) {
    // IPv6 — 16 bytes
    if (offset + 16 > buf.byteLength) throw new Error("IPv6 truncated");
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(view.getUint16(offset, false).toString(16));
      offset += 2;
    }
    address = `[${parts.join(":")}]`;

  } else {
    throw new Error(`Unknown address type: ${addrType}`);
  }

  return { uuid, command, port, address, payloadOffset: offset };
}

// ---------------------------------------------------------------------------
// Cleanup helper — close everything without throwing
// ---------------------------------------------------------------------------

function safeClose(ws, code = 1000, reason = "done") {
  try { ws.close(code, reason); } catch {}
}

async function safeCloseWriter(writer) {
  if (!writer) return;
  try { await writer.close(); } catch {}
}

async function safeCloseSocket(socket) {
  if (!socket) return;
  try { socket.close(); } catch {}
}

// ---------------------------------------------------------------------------
// WebSocket proxy handler
// ---------------------------------------------------------------------------

async function handleWebSocket(request, env, ctx) {
  const { UUID, PROXYIP } = env;

  // ── Validate env ─────────────────────────────────────────────────────────
  if (!UUID) {
    console.error("[CloudBreak] UUID environment variable not set");
    return new Response("Worker misconfigured", { status: 500 });
  }

  let expectedUuidBytes;
  try {
    expectedUuidBytes = uuidToBytes(UUID);
  } catch (err) {
    console.error("[CloudBreak] Invalid UUID in env:", err.message);
    return new Response("Worker misconfigured", { status: 500 });
  }

  // ── Must be a WebSocket upgrade ──────────────────────────────────────────
  const upgradeHeader = request.headers.get("Upgrade") || "";
  if (upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("Upgrade: websocket required", {
      status: 426,
      headers: { Upgrade: "websocket" },
    });
  }

  // ── Create WebSocket pair ────────────────────────────────────────────────
  const [clientWs, serverWs] = new WebSocketPair();
  serverWs.accept();

  // State
  let tcpSocket             = null;
  let tcpWriter             = null;
  let connectionEstablished = false;
  let processingHeader      = false; // mutex for first-message
  let authTimer             = null;
  let cleanedUp             = false;

  // Session promise — keeps worker alive
  let resolveSession;
  const sessionDone = new Promise((r) => (resolveSession = r));

  // ── Shared cleanup ───────────────────────────────────────────────────────
  async function cleanup(wsCode = 1000, wsReason = "done") {
    if (cleanedUp) return;
    cleanedUp = true;
    if (authTimer) clearTimeout(authTimer);
    safeClose(serverWs, wsCode, wsReason);
    await safeCloseWriter(tcpWriter);
    await safeCloseSocket(tcpSocket);
    resolveSession();
  }

  // ── Auth timeout — drop connection if no valid header within 10s ─────────
  authTimer = setTimeout(() => {
    if (!connectionEstablished) {
      console.warn("[CloudBreak] Auth timeout — no valid header");
      cleanup(1008, "Auth timeout");
    }
  }, AUTH_TIMEOUT_MS);

  // ── Message handler ──────────────────────────────────────────────────────
  serverWs.addEventListener("message", async (event) => {
    try {
      const rawData = event.data;
      const buf =
        rawData instanceof ArrayBuffer
          ? rawData
          : new TextEncoder().encode(String(rawData)).buffer;

      // ── First message: parse VLESS header ─────────────────────────────
      if (!connectionEstablished) {
        // Mutex — ignore duplicate first messages
        if (processingHeader) return;
        processingHeader = true;

        let parsed;
        try {
          parsed = parseVlessHeader(buf);
        } catch (err) {
          console.error("[CloudBreak] VLESS parse error:", err.message);
          await cleanup(1002, "Bad VLESS header");
          return;
        }

        // UUID check (constant-time)
        if (!bytesEqual(parsed.uuid, expectedUuidBytes)) {
          console.warn("[CloudBreak] UUID mismatch — dropping");
          await cleanup(1008, "Unauthorized");
          return;
        }

        // Only TCP (0x01) supported
        if (parsed.command !== 0x01) {
          console.warn(`[CloudBreak] Unsupported command: ${parsed.command}`);
          await cleanup(1003, "Unsupported command");
          return;
        }

        // Port sanity check
        if (parsed.port < 1 || parsed.port > 65535) {
          console.warn(`[CloudBreak] Invalid port: ${parsed.port}`);
          await cleanup(1002, "Invalid port");
          return;
        }

        // ── Determine destination ────────────────────────────────────────
        const destHost = PROXYIP?.trim() || parsed.address;
        const destPort = PROXYIP?.trim() ? 443 : parsed.port;

        // ── TCP connect with timeout ─────────────────────────────────────
        const connectTimer = setTimeout(() => {
          console.warn(`[CloudBreak] TCP connect timeout → ${destHost}:${destPort}`);
          cleanup(1011, "TCP timeout");
        }, CONNECT_TIMEOUT_MS);

        try {
          tcpSocket = connect({ hostname: destHost, port: destPort });
          tcpWriter = tcpSocket.writable.getWriter();
          clearTimeout(connectTimer);
        } catch (err) {
          clearTimeout(connectTimer);
          console.error(`[CloudBreak] TCP connect failed → ${destHost}:${destPort}:`, err.message);
          await cleanup(1011, "TCP connection failed");
          return;
        }

        // Clear auth timer — we have a valid connection
        clearTimeout(authTimer);
        authTimer = null;

        // Send VLESS response header
        try {
          serverWs.send(new Uint8Array([0x00, 0x00]));
        } catch (err) {
          console.error("[CloudBreak] Failed to send VLESS response:", err.message);
          await cleanup(1011, "Send failed");
          return;
        }

        connectionEstablished = true;

        // Forward initial payload after VLESS header
        if (parsed.payloadOffset < buf.byteLength) {
          try {
            await tcpWriter.write(new Uint8Array(buf.slice(parsed.payloadOffset)));
          } catch (err) {
            console.error("[CloudBreak] Initial payload write failed:", err.message);
            await cleanup(1011, "Write failed");
            return;
          }
        }

        // ── Pump TCP → WebSocket ─────────────────────────────────────────
        ctx.waitUntil((async () => {
          let reader;
          try {
            reader = tcpSocket.readable.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              try {
                serverWs.send(value);
              } catch {
                break; // WS closed
              }
            }
          } catch (err) {
            // Remote closed — normal for most requests
          } finally {
            try { reader?.releaseLock(); } catch {}
            await cleanup(1000, "Remote closed");
          }
        })());

        return;
      }

      // ── Subsequent messages: raw proxy data ─────────────────────────────
      if (!tcpWriter) {
        console.warn("[CloudBreak] tcpWriter not ready — dropping frame");
        return;
      }
      try {
        await tcpWriter.write(new Uint8Array(buf));
      } catch (err) {
        console.error("[CloudBreak] Proxy write error:", err.message);
        await cleanup(1011, "Write error");
      }

    } catch (err) {
      console.error("[CloudBreak] Unhandled message error:", err.message);
      await cleanup(1011, "Internal error");
    }
  });

  serverWs.addEventListener("close", async () => {
    await cleanup(1000, "Client closed");
  });

  serverWs.addEventListener("error", async (err) => {
    console.error("[CloudBreak] WebSocket error:", err?.message ?? err);
    await cleanup(1011, "WebSocket error");
  });

  // Keep worker alive for the session
  ctx.waitUntil(sessionDone);

  return new Response(null, { status: 101, webSocket: clientWs });
}

// ---------------------------------------------------------------------------
// Subscription endpoint
// ---------------------------------------------------------------------------

function handleSub(request, env) {
  const { UUID, WS_PATH = "/ws" } = env;

  if (!UUID) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const host      = request.headers.get("Host") || "your-worker.workers.dev";
    const vlessLink = makeVlessLink(UUID, host, WS_PATH);
    const vmessLink = makeVmessLink(UUID, host, WS_PATH);
    const b64       = safeBase64(`${vlessLink}\n${vmessLink}`);

    return new Response(b64, {
      headers: {
        "Content-Type":  "text/plain; charset=utf-8",
        "Cache-Control": "no-store, no-cache",
        "X-Robots-Tag":  "noindex",
      },
    });
  } catch (err) {
    console.error("[CloudBreak] /sub error:", err.message);
    return new Response("Internal Error", { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

function handleHealth(request, env) {
  try {
    const { UUID, WS_PATH = "/ws", DEPLOY_TIME = "unknown" } = env;
    const host = request.headers.get("Host") || "unknown";

    return new Response(
      JSON.stringify({
        status:           "ok",
        worker:           "CloudBreak",
        protocols:        ["vless", "vmess"],
        transport:        "websocket",
        tls:              "cloudflare",
        host,
        ws_path:          WS_PATH,
        uuid_configured:  Boolean(UUID),
        deployed:         DEPLOY_TIME,
        timestamp:        new Date().toISOString(),
      }, null, 2),
      {
        headers: {
          "Content-Type":  "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err) {
    console.error("[CloudBreak] /health error:", err.message);
    return new Response('{"status":"error"}', {
      status:  500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ---------------------------------------------------------------------------
// Link generators
// ---------------------------------------------------------------------------

function makeVlessLink(uuid, host, wsPath) {
  const params = new URLSearchParams({
    encryption: "none",
    security:   "tls",
    sni:        host,
    fp:         "chrome",
    type:       "ws",
    host:       host,
    path:       wsPath,
    alpn:       "h2,http/1.1",
  });
  return `vless://${uuid}@${host}:443?${params.toString()}#CF-VLESS-IR`;
}

function makeVmessLink(uuid, host, wsPath) {
  const config = {
    v:    "2",
    ps:   "CF-VMess-IR",
    add:  host,
    port: 443,
    id:   uuid,
    aid:  0,
    net:  "ws",
    type: "none",
    host: host,
    path: wsPath,
    tls:  "tls",
    sni:  host,
    alpn: "h2,http/1.1",
    fp:   "chrome",
  };
  return `vmess://${safeBase64(JSON.stringify(config))}`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    try {
      const url    = new URL(request.url);
      const path   = url.pathname;
      const wsPath = env.WS_PATH  || "/ws";
      const subPath = env.SUB_PATH || "/sub";

      // Only allow GET / WebSocket upgrade methods
      const method = request.method.toUpperCase();
      if (method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      if (path === wsPath)   return handleWebSocket(request, env, ctx);
      if (path === subPath)  return handleSub(request, env);
      if (path === "/health") return handleHealth(request, env);
      if (path === "/")      return new Response("CloudBreak Worker — Active", {
        headers: { "Content-Type": "text/plain" },
      });

      return new Response("Not Found", { status: 404 });

    } catch (err) {
      // Top-level catch — nothing should reach here but just in case
      console.error("[CloudBreak] Top-level error:", err.message, err.stack);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
    
