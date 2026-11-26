// The Room Durable Object: one per shared score. Orders edits, tracks who is
// connected, and brings late joiners up to date. No measure locks since
// 2026-11-25: the edit order (seq) decides who wins a measure.

import { DurableObject } from "cloudflare:workers";
import { base64ToBytes, bytesToBase64, scoreKey } from "./http.js";

const shortId = (id) => String(id || "").replace(/^[up]_/, "").slice(0, 6);

const MAX_SNAPSHOT_B64 = 24 * 1024 * 1024;  // ~18 MB score
const MAX_STORED_EDIT = 1_800_000;          // DO storage values must stay under 2 MB
const COMPACT_AFTER_EDITS = 300;            // then ask for a fresh snapshot
const MAX_PENDING_EDITS = 2000;             // refuse edits until a snapshot arrives

const editKey = (seq) => `edit:${String(seq).padStart(12, "0")}`;

export class Room extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        // Room-wide counters; persisted, reloaded after the object sleeps.
        this.meta = { seq: 0, nextClientId: 1, baseSeq: 0, hasSnapshot: false, title: "", projectId: "", lastCompactAsk: 0 };
        ctx.blockConcurrencyWhile(async () => {
            const saved = await ctx.storage.get("meta");
            if (saved) {
                this.meta = { ...this.meta, ...saved };
            }
        });
    }

    async saveMeta() {
        await this.ctx.storage.put("meta", this.meta);
    }

    // --- connections (only reached through the Worker's membership check) ---

    async fetch(request) {
        // From the Worker only (Durable Objects aren't reachable directly):
        // a score uploaded on the website becomes this room's first score.
        if (new URL(request.url).pathname === "/init" && request.method === "POST") {
            const projectId = request.headers.get("X-Collab-Project-Id") || "";
            const title = decodeURIComponent(request.headers.get("X-Collab-Title") || "") || "Untitled score";
            const bytes = new Uint8Array(await request.arrayBuffer());
            await this.env.SCORES.put(scoreKey(projectId), bytes, {
                httpMetadata: { contentType: "application/x-musescore" },
                customMetadata: { baseSeq: String(this.meta.seq), title },
            });
            this.meta.projectId = projectId;
            this.meta.hasSnapshot = true;
            this.meta.baseSeq = this.meta.seq;
            this.meta.title = title;
            await this.saveMeta();
            return new Response("ok");
        }

        const path = new URL(request.url).pathname;
        // Owner removed someone: disconnect them now (they can't reconnect -
        // the Worker checks membership on every connection).
        if (path === "/kick" && request.method === "POST") {
            const gone = request.headers.get("X-Collab-User-Id") || "";
            for (const ws of this.sockets()) {
                if (this.info(ws).userId === gone) {
                    try {
                        ws.close(4003, "removed from this score");
                    } catch {
                        // already closed
                    }
                }
            }
            return new Response("ok");
        }
        // Score deleted: disconnect everyone and forget everything.
        if (path === "/purge" && request.method === "POST") {
            for (const ws of this.sockets()) {
                try {
                    ws.close(4004, "this score was deleted");
                } catch {
                    // already closed
                }
            }
            await this.ctx.storage.deleteAll();
            this.meta = { seq: 0, nextClientId: 1, baseSeq: 0, hasSnapshot: false, title: "", projectId: "", lastCompactAsk: 0 };
            return new Response("ok");
        }

        const userId = request.headers.get("X-Collab-User-Id") || "";
        const name = decodeURIComponent(request.headers.get("X-Collab-User-Name") || "") || "Guest";
        const projectId = request.headers.get("X-Collab-Project-Id") || "";
        if (!userId || !projectId) {
            return new Response("forbidden", { status: 403 });
        }
        if (this.meta.projectId !== projectId) {
            this.meta.projectId = projectId;
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        const refused = await this.refusal(projectId);
        if (refused) {
            this.ctx.acceptWebSocket(server);
            server.close(4005, refused);
            return new Response(null, { status: 101, webSocket: client });
        }
        this.ctx.acceptWebSocket(server);
        const id = this.meta.nextClientId++;
        await this.saveMeta();
        server.serializeAttachment({ id, userId, name, color: "#888888" });
        return new Response(null, { status: 101, webSocket: client });
    }

    info(ws) {
        return ws.deserializeAttachment() || { id: 0, userId: "", name: "?", color: "#888888" };
    }

    //! Why a new connection to this score is refused (closed with 4005 and this reason), or null.
    //! A deployment can subclass Room to refuse some scores; here every score is open.
    async refusal(_projectId) {
        return null;
    }

    sockets() {
        return this.ctx.getWebSockets();
    }

    send(ws, msg) {
        try {
            ws.send(JSON.stringify(msg));
        } catch {
            // socket already closing; ignore
        }
    }

    broadcast(msg, except) {
        const text = JSON.stringify(msg);
        for (const ws of this.sockets()) {
            if (ws !== except) {
                try {
                    ws.send(text);
                } catch {
                    // ignore
                }
            }
        }
    }

    peersOf(sockets) {
        return sockets.map((ws) => {
            const c = this.info(ws);
            return { id: c.id, name: c.name, color: c.color, accountId: shortId(c.userId) };
        });
    }

    // --- messages ---------------------------------------------------------

    async webSocketMessage(ws, data) {
        if (typeof data !== "string") {
            return;
        }
        let msg;
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }
        // "null", "42", "[]" parse fine but aren't messages; msg.type on null threw.
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
            return;
        }
        const me = this.info(ws);

        switch (msg.type) {
        case "join": {
            // The account name is authoritative; the colour is the app's choice.
            me.color = String(msg.color || me.color).slice(0, 16);
            ws.serializeAttachment(me);
            this.send(ws, {
                type: "welcome",
                clientId: me.id,
                name: me.name,
                seq: this.meta.seq,
                peers: this.peersOf(this.sockets()),
                snapshot: { exists: this.meta.hasSnapshot, baseSeq: this.meta.baseSeq, title: this.meta.title },
            });
            this.broadcast({ type: "presence", peers: this.peersOf(this.sockets()) }, ws);
            break;
        }

        case "lock":
            break; // apps from before 2026-11-25 still send their selection as a lock: ignored

        case "edit": {
            // No locks: the order given here (seq) decides who wins a measure.
            // Don't let the edit log grow without bound: a client that never
            // answers snapshot-request gets its edits refused until one arrives.
            if (this.meta.seq - this.meta.baseSeq >= MAX_PENDING_EDITS) {
                this.send(ws, { type: "edit-rejected", editId: msg.editId, reason: "too many edits since the last saved score" });
                this.send(ws, { type: "snapshot-request" });
                break;
            }
            this.meta.seq += 1;
            const out = { ...msg, seq: this.meta.seq, from: me.id, name: me.name };
            const text = JSON.stringify(out);
            const storable = text.length <= MAX_STORED_EDIT;
            if (storable) {
                await this.ctx.storage.put(editKey(out.seq), text);
            }
            await this.saveMeta();
            this.broadcast(out, ws);
            this.send(ws, { type: "ack", seq: out.seq, editId: msg.editId });

            const pending = this.meta.seq - this.meta.baseSeq;
            if (!storable || (pending >= COMPACT_AFTER_EDITS && this.meta.seq - this.meta.lastCompactAsk >= 50)) {
                this.meta.lastCompactAsk = this.meta.seq;
                await this.saveMeta();
                this.send(ws, { type: "snapshot-request" });
            }
            break;
        }

        case "snapshot-put":
            await this.putSnapshot(ws, msg);
            break;

        case "structure":
            // Instruments, measures, time/key signatures changed: those can't
            // travel as a measure paste, so the sender's whole score becomes
            // the room's score - as a numbered step in the edit order - and
            // everyone else reloads it.
            await this.putSnapshot(ws, msg, me);
            break;

        case "sync":
            await this.sync(ws, Number.isFinite(msg.sinceSeq) ? msg.sinceSeq : -1);
            break;

        case "cursor":
        case "selection":
            // The only client messages passed on to others. Anything else a
            // client sends is dropped, so nobody can forge server messages
            // (snapshot, welcome, presence...) to other members.
            this.broadcast({ ...msg, type: msg.type, from: me.id, name: me.name }, ws);
            break;

        default:
            break;
        }
    }

    //! A client's full score → R2 (scores/<projectId>.mscz); drop the edits it already contains.
    //! With `structureFrom` (a structural change by that client) it also takes the next
    //! edit number and is sent to everyone else to reload.
    async putSnapshot(ws, msg, structureFrom = null) {
        const data = typeof msg.data === "string" ? msg.data : "";
        const baseSeq = structureFrom ? this.meta.seq + 1 : Math.trunc(Number(msg.baseSeq));
        if (structureFrom) {
            msg = { ...msg, baseSeq };
        }
        const maxSeq = structureFrom ? this.meta.seq + 1 : this.meta.seq;
        if (!data || data.length > MAX_SNAPSHOT_B64 || !Number.isFinite(baseSeq) || baseSeq < 0 || baseSeq > maxSeq
            || !this.meta.projectId) {
            this.send(ws, { type: "snapshot-refused" });
            return;
        }
        if (this.meta.hasSnapshot && baseSeq < this.meta.baseSeq) {
            this.send(ws, { type: "snapshot-refused", reason: "older than the one we have" });
            return;
        }
        let bytes;
        try {
            bytes = base64ToBytes(data);
        } catch {
            this.send(ws, { type: "snapshot-refused", reason: "not base64" });
            return;
        }
        // A real .mscz is a zip file ("PK").
        if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
            this.send(ws, { type: "snapshot-refused", reason: "not an .mscz file" });
            return;
        }
        const title = typeof msg.title === "string" && msg.title ? msg.title.slice(0, 128) : this.meta.title;
        await this.env.SCORES.put(scoreKey(this.meta.projectId), bytes, {
            httpMetadata: { contentType: "application/x-musescore" },
            customMetadata: { baseSeq: String(baseSeq), title },
        });

        const old = await this.ctx.storage.list({ prefix: "edit:", end: editKey(baseSeq + 1) });
        const stale = [...old.keys()];
        for (let i = 0; i < stale.length; i += 128) {
            await this.ctx.storage.delete(stale.slice(i, i + 128));
        }

        this.meta.hasSnapshot = true;
        this.meta.baseSeq = baseSeq;
        this.meta.title = title;
        if (structureFrom) {
            this.meta.seq = baseSeq;
        }
        await this.saveMeta();
        await this.env.DB.prepare("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?")
            .bind(title, Date.now(), this.meta.projectId).run();

        if (structureFrom) {
            this.broadcast({ type: "snapshot", reload: true, baseSeq, title, data, from: structureFrom.id,
                             name: structureFrom.name }, ws);
            this.send(ws, { type: "ack", seq: baseSeq, editId: msg.editId });
        } else {
            this.send(ws, { type: "snapshot-saved", baseSeq });
        }
    }

    //! Bring a client up to date: the edits after `sinceSeq`, or — if it has
    //! nothing usable — the whole score first, then the edits after it.
    async sync(ws, sinceSeq) {
        let from = sinceSeq;
        if (sinceSeq < this.meta.baseSeq || sinceSeq > this.meta.seq) {
            const obj = this.meta.hasSnapshot ? await this.env.SCORES.get(scoreKey(this.meta.projectId)) : null;
            if (!obj) {
                this.send(ws, { type: "no-snapshot", seq: this.meta.seq });
                return;
            }
            const bytes = new Uint8Array(await obj.arrayBuffer());
            this.send(ws, { type: "snapshot", baseSeq: this.meta.baseSeq, title: this.meta.title, data: bytesToBase64(bytes) });
            from = this.meta.baseSeq;
        }
        const edits = await this.ctx.storage.list({ prefix: "edit:", start: editKey(from + 1) });
        for (const text of edits.values()) {
            try {
                ws.send(text);
            } catch {
                return;
            }
        }
        this.send(ws, { type: "synced", seq: this.meta.seq });
    }

    async webSocketClose(ws, code, reason) {
        try {
            ws.close(code, reason);
        } catch {
            // already closed
        }
        const others = this.sockets().filter((s) => s !== ws);
        for (const s of others) {
            this.send(s, { type: "presence", peers: this.peersOf(others) });
        }
    }

    async webSocketError(ws) {
        await this.webSocketClose(ws, 1011, "error");
    }
}
