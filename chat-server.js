/**
 * ============================================================
 *  REAL-TIME CHAT SERVER — WebSockets from scratch
 *  Stack: Node.js  +  'ws' library  +  in-memory persistence
 * ============================================================
 *
 * CONCEPTS COVERED
 * ────────────────
 * 1. What WebSockets are and how they differ from HTTP
 * 2. The WebSocket handshake (HTTP → WS upgrade)
 * 3. Server-side connection lifecycle (open → message → close)
 * 4. Broadcasting messages to all connected clients
 * 5. Rate limiting (token-bucket algorithm)
 * 6. Message persistence (in-memory store with cap)
 * 7. Heartbeat / ping-pong to detect dead connections
 * 8. Graceful shutdown
 */

// ─────────────────────────────────────────────────────────────
// STEP 0 — Dependencies
// ─────────────────────────────────────────────────────────────
// 'ws' is the most widely used WebSocket library for Node.js.
// It wraps the low-level net.Socket and speaks the RFC 6455
// WebSocket protocol so we don't have to implement binary
// framing and masking by hand.
//
// Install with:  npm install ws
// ─────────────────────────────────────────────────────────────
const { WebSocketServer, WebSocket } = require("ws");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────
// STEP 1 — Configuration constants
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3001,

  // ── Rate Limiting (token-bucket algorithm) ─────────────────
  // Each client gets a "bucket" that holds up to MAX_TOKENS.
  // Sending a message costs 1 token.
  // Tokens refill at REFILL_RATE per REFILL_INTERVAL ms.
  // Result: burst of 10, then sustained 2 msg/s.
  RATE_LIMIT: {
    MAX_TOKENS: 10,
    REFILL_RATE: 2,
    REFILL_INTERVAL: 1000,
  },

  // ── Message Persistence ────────────────────────────────────
  // Keep the last N messages in memory.
  // A real app would write to Postgres / Redis / DynamoDB.
  MAX_HISTORY: 50,

  // ── Heartbeat ─────────────────────────────────────────────
  // TCP can silently drop connections (NAT timeout, mobile sleep).
  // We send a WebSocket PING frame every N ms.
  // If no PONG arrives before the next ping → terminate.
  HEARTBEAT_INTERVAL: 30_000,

  MAX_USERNAME_LEN: 20,
  MAX_MESSAGE_LEN: 500,
};

// ─────────────────────────────────────────────────────────────
// STEP 2 — In-memory message store (persistence layer)
// ─────────────────────────────────────────────────────────────
// New clients who join mid-conversation see recent history.
// We cap the array to avoid unbounded memory growth.
// ─────────────────────────────────────────────────────────────
const messageHistory = [];   // [ { id, username, text, ts } ]

function persistMessage(msg) {
  messageHistory.push(msg);
  if (messageHistory.length > CONFIG.MAX_HISTORY) {
    messageHistory.shift(); // drop oldest
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 3 — Token-bucket rate limiter (per client)
// ─────────────────────────────────────────────────────────────
// HOW IT WORKS:
//  - Client starts with a full bucket (MAX_TOKENS).
//  - Each message sent costs 1 token.
//  - Every REFILL_INTERVAL ms, tokens += REFILL_RATE (capped).
//  - Empty bucket → message dropped + warning sent to client.
// ─────────────────────────────────────────────────────────────
function createRateLimiter() {
  let tokens = CONFIG.RATE_LIMIT.MAX_TOKENS;

  const refillTimer = setInterval(() => {
    tokens = Math.min(
      CONFIG.RATE_LIMIT.MAX_TOKENS,
      tokens + CONFIG.RATE_LIMIT.REFILL_RATE
    );
  }, CONFIG.RATE_LIMIT.REFILL_INTERVAL);

  return {
    consume() {
      if (tokens > 0) { tokens--; return true; }
      return false;
    },
    destroy() { clearInterval(refillTimer); }, // prevent memory leak
    get remaining() { return tokens; },
  };
}

// ─────────────────────────────────────────────────────────────
// STEP 4 — Connected clients registry
// ─────────────────────────────────────────────────────────────
// Map of  clientId → { ws, username, rateLimiter }
// ─────────────────────────────────────────────────────────────
const clients = new Map();

// ─────────────────────────────────────────────────────────────
// STEP 5 — Helpers: send JSON and broadcast
// ─────────────────────────────────────────────────────────────
// Every message uses a typed envelope { type, payload }.
// This gives the client a protocol to switch on.
// ─────────────────────────────────────────────────────────────
function sendJSON(ws, type, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ type, payload })); }
  catch (err) { console.error("[send]", err.message); }
}

function broadcast(type, payload, excludeId = null) {
  for (const [id, client] of clients) {
    if (id !== excludeId) sendJSON(client.ws, type, payload);
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 6 — Input validation
// ─────────────────────────────────────────────────────────────
function validateUsername(name) {
  if (!name || typeof name !== "string") return "Username required";
  const t = name.trim();
  if (t.length < 1) return "Username too short";
  if (t.length > CONFIG.MAX_USERNAME_LEN) return `Max ${CONFIG.MAX_USERNAME_LEN} chars`;
  if (!/^[\w\- ]+$/.test(t)) return "Letters, numbers, spaces, hyphens only";
  return null;
}

function validateMessage(text) {
  if (!text || typeof text !== "string") return "Empty message";
  if (text.trim().length === 0) return "Empty message";
  if (text.trim().length > CONFIG.MAX_MESSAGE_LEN) return `Max ${CONFIG.MAX_MESSAGE_LEN} chars`;
  return null;
}

// ─────────────────────────────────────────────────────────────
// STEP 7 — Create the HTTP server
// ─────────────────────────────────────────────────────────────
// WHY an HTTP server underneath?
// WebSockets start as an HTTP/1.1 request with an
// "Upgrade: websocket" header.  The 'ws' library intercepts
// that upgrade event, so both HTTP and WS share port 3001.
// ─────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // Serve the chat UI at the root URL
  if (req.url === "/" || req.url === "/index.html") {
    const filePath = path.join(__dirname, "chat-client.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end("chat-client.html not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }
  // Health check endpoint
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      clients: clients.size,
      messages: messageHistory.length,
    }));
    return;
  }
  res.writeHead(404); res.end("Not found");
});

// ─────────────────────────────────────────────────────────────
// STEP 8 — Create the WebSocket server (attached to HTTP)
// ─────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// ─────────────────────────────────────────────────────────────
// STEP 9 — Connection lifecycle handler
// ─────────────────────────────────────────────────────────────
// 'connection' fires once per completed WebSocket handshake.
// After this point both sides can send frames freely — full duplex.
// ─────────────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const clientId = crypto.randomUUID();
  const ip = req.socket.remoteAddress;
  console.log(`[+] Connected  id=${clientId}  ip=${ip}`);

  let username = null;
  const rateLimiter = createRateLimiter();

  // ── Heartbeat setup ────────────────────────────────────────
  // isAlive is flipped false before each ping.
  // Receiving a PONG (sent automatically by the browser) sets it true.
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // ── Incoming message handler ───────────────────────────────
  ws.on("message", (rawData) => {
    let envelope;
    try { envelope = JSON.parse(rawData.toString()); }
    catch { sendJSON(ws, "error", { message: "Invalid JSON" }); return; }

    const { type, payload = {} } = envelope;

    switch (type) {

      // ── JOIN: client picks a username ─────────────────────
      case "join": {
        if (username) { sendJSON(ws, "error", { message: "Already joined" }); return; }

        const err = validateUsername(payload.username);
        if (err) { sendJSON(ws, "error", { message: err }); return; }

        const taken = [...clients.values()].some(
          (c) => c.username.toLowerCase() === payload.username.trim().toLowerCase()
        );
        if (taken) { sendJSON(ws, "error", { message: "Username already taken" }); return; }

        username = payload.username.trim();
        clients.set(clientId, { ws, username, rateLimiter });
        console.log(`[join] ${username}`);

        // Send history + welcome to the new client
        sendJSON(ws, "welcome", {
          clientId, username,
          history: messageHistory,
          onlineCount: clients.size,
        });

        // Announce arrival to everyone else
        broadcast("user_joined", { username, onlineCount: clients.size }, clientId);
        break;
      }

      // ── CHAT: send a message ──────────────────────────────
      case "chat": {
        if (!username) { sendJSON(ws, "error", { message: "Please join first" }); return; }

        // Rate-limit check
        if (!rateLimiter.consume()) {
          sendJSON(ws, "rate_limited", {
            message: "Too many messages. Slow down!",
            retryAfter: CONFIG.RATE_LIMIT.REFILL_INTERVAL / 1000,
          });
          return;
        }

        const textErr = validateMessage(payload.text);
        if (textErr) { sendJSON(ws, "error", { message: textErr }); return; }

        const msg = {
          id: crypto.randomUUID(),
          username,
          text: payload.text.trim(),
          ts: Date.now(),
        };

        persistMessage(msg);          // save to history
        broadcast("chat", msg);       // send to everyone (incl. sender)
        console.log(`[chat] ${username}: ${msg.text.substring(0, 60)}`);
        break;
      }

      // ── TYPING: ephemeral indicator, not persisted ────────
      case "typing": {
        if (!username) return;
        broadcast("typing", { username, isTyping: !!payload.isTyping }, clientId);
        break;
      }

      default:
        sendJSON(ws, "error", { message: `Unknown type: ${type}` });
    }
  });

  // ── Disconnect ─────────────────────────────────────────────
  // Fires whether client closed cleanly (1000), navigated away,
  // or network dropped. Always clean up timers and registry.
  ws.on("close", (code) => {
    console.log(`[-] ${username ?? "unjoined"}  code=${code}`);
    clients.delete(clientId);
    rateLimiter.destroy();
    if (username) broadcast("user_left", { username, onlineCount: clients.size });
  });

  // ── Socket error ───────────────────────────────────────────
  // Network-level errors (ECONNRESET etc.). 'close' fires next.
  ws.on("error", (err) => {
    console.error(`[ws error] ${username ?? clientId}: ${err.message}`);
  });
});

// ─────────────────────────────────────────────────────────────
// STEP 10 — Heartbeat interval (zombie-connection reaper)
// ─────────────────────────────────────────────────────────────
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log("[heartbeat] terminating zombie socket");
      ws.terminate();   // hard close — skip FIN handshake
      return;
    }
    ws.isAlive = false;
    ws.ping();          // browser replies with pong automatically
  });
}, CONFIG.HEARTBEAT_INTERVAL);

wss.on("close", () => clearInterval(heartbeatInterval));

// ─────────────────────────────────────────────────────────────
// STEP 11 — Start listening
// ─────────────────────────────────────────────────────────────
httpServer.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   Chat WebSocket Server running              ║
║   ws://localhost:${CONFIG.PORT}                      ║
║   http://localhost:${CONFIG.PORT}/health             ║
╚══════════════════════════════════════════════╝`);
});

// ─────────────────────────────────────────────────────────────
// STEP 12 — Graceful shutdown
// ─────────────────────────────────────────────────────────────
// On SIGTERM (Docker/k8s) or SIGINT (Ctrl+C):
//   1. Stop accepting connections
//   2. Send close frame to all clients (code 1001 = going away)
//   3. Exit cleanly
// ─────────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[shutdown] ${signal} received`);
  wss.clients.forEach((ws) => ws.close(1001, "Server shutting down"));
  httpServer.close(() => { console.log("[shutdown] done"); process.exit(0); });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
