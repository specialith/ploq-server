// Ploq — local sync relay, for app development without Cloudflare (no accounts).
//
// Plays the role of the Room Durable Object (src/room.js):
// one "room" per score; it gives every edit an order number (seq) and
// forwards it to everyone else in the room. Keep the logic here small and
// framework-free.
//
// Run:  node relay/server.mjs [port]  (or npm run relay)      (default port 8787)
// Clients connect to  ws://127.0.0.1:<port>/<room>
//
// Messages are JSON text frames. See docs/collab/PROTOCOL.md in ploq-app.

import { WebSocketServer } from "ws";
import { cleanPresence } from "../src/presence.js";

const port = Number(process.argv[2] || process.env.COLLAB_PORT || 8787);

/** room name -> { seq, nextClientId, clients: Map<ws, {id, name, color}> } */
const rooms = new Map();

function getRoom(name) {
    let room = rooms.get(name);
    if (!room) {
        room = { seq: 0, nextClientId: 1, clients: new Map() };
        rooms.set(name, room);
    }
    return room;
}

function send(ws, msg) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function broadcast(room, msg, except) {
    for (const ws of room.clients.keys()) {
        if (ws !== except) {
            send(ws, msg);
        }
    }
}

function presence(room) {
    return [...room.clients.values()].map(c => ({ id: c.id, name: c.name, color: c.color }));
}

function log(...args) {
    console.log(new Date().toISOString().slice(11, 23), ...args);
}

// No measure locks (removed 2026-11-25): anyone can edit any measure. The
// order this relay gives edits (seq) decides: for a measure two people change
// at once, the later edit wins on every copy (the apps re-apply their own
// unacknowledged edits on top of earlier ones). Selections still travel as
// "selection" messages, which the apps draw as highlights.

// Security:
// - Browsers always send an Origin header on WebSocket connections; the
//   MuseScore client (QWebSocket) and Node clients don't. Rejecting any
//   Origin stops a web page open in the user's browser from joining a room
//   on this localhost relay and pushing edits into their score.
// - maxPayload caps a single message (a whole-score edit is well under this).
// Real authentication (who may join a room) arrives with sign-in in Phase 7.
const MAX_PAYLOAD = 8 * 1024 * 1024;

const wss = new WebSocketServer({
    host: "127.0.0.1",
    port,
    maxPayload: MAX_PAYLOAD,
    verifyClient: ({ req }) => {
        if (req.headers.origin) {
            log(`rejected connection with Origin ${req.headers.origin}`);
            return false;
        }
        return true;
    },
});

wss.on("connection", (ws, req) => {
    const roomName = decodeURIComponent((req.url || "/").replace(/^\/+/, "")) || "default";
    const room = getRoom(roomName);
    const client = { id: room.nextClientId++, name: `user${room.nextClientId - 1}`, color: "#888888" };
    room.clients.set(ws, client);
    log(`[${roomName}] client ${client.id} connected (${room.clients.size} in room)`);

    ws.on("message", (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch {
            log(`[${roomName}] client ${client.id}: bad JSON, ignored`);
            return;
        }
        // "null", "42", "[]" parse fine but aren't messages ("null" used to crash
        // the relay for every room).
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
            log(`[${roomName}] client ${client.id}: not a message object, ignored`);
            return;
        }
        try {
            handleMessage(ws, room, roomName, client, msg);
        } catch (e) {
            log(`[${roomName}] client ${client.id}: ${msg.type} failed: ${e?.message}`); // never take the relay down
        }
    });

    ws.on("close", () => {
        onClose(ws, room, roomName, client);
    });
});

function handleMessage(ws, room, roomName, client, msg) {
    switch (msg.type) {
    case "join":
        client.name = String(msg.name || client.name);
        client.color = String(msg.color || client.color);
        send(ws, { type: "welcome", clientId: client.id, seq: room.seq, peers: presence(room) });
        broadcast(room, { type: "presence", peers: presence(room) }, ws);
        log(`[${roomName}] client ${client.id} joined as "${client.name}"`);
        break;

    case "lock":
        break; // apps from before 2026-11-25 still send their selection as a lock: ignored

    case "edit": {
        // The server decides the order everyone applies edits in (and so who
        // wins when two people change the same measure at once).
        room.seq += 1;
        const out = { ...msg, seq: room.seq, from: client.id, name: client.name };
        broadcast(room, out, ws);
        send(ws, { type: "ack", seq: room.seq, editId: msg.editId });
        log(`[${roomName}] edit #${room.seq} from ${client.name}: ticks ${msg.tickFrom}-${msg.tickTo}, `
            + `staves ${msg.staffFrom}-${msg.staffTo}, ${String(msg.xml || "").length} bytes`);
        break;
    }

    case "cursor":
    case "selection": {
        // The only client-to-client messages, as on the Cloudflare server.
        // Forwarding anything else let a client forge server messages
        // (welcome, presence, snapshot) to everyone else. Checked the same
        // way as there (src/presence.js).
        const clean = cleanPresence(msg);
        if (clean) {
            broadcast(room, { ...clean, from: client.id, name: client.name }, ws);
        }
        break;
    }

    default:
        break;
    }
}

function onClose(ws, room, roomName, client) {
    room.clients.delete(ws);
    broadcast(room, { type: "presence", peers: presence(room) });
    log(`[${roomName}] client ${client.id} left (${room.clients.size} in room)`);
    if (room.clients.size === 0) {
        rooms.delete(roomName);
    }
}

wss.on("listening", () => log(`collab relay listening on ws://127.0.0.1:${port}/<room>`));
