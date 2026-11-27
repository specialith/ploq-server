// Projects (scores): list, create, upload, open, invites, members, delete, and accepting an invite.
//
// `hooks` (all optional) let a deployment add rules on top, e.g. plan limits:
//   projectLimit(user, config) -> how many scores this user may own (undefined/Infinity: no limit)
//   limitError(limit, config)  -> the Response when that limit is reached
//   gate(project, role, action) -> a Response refusing "open" / "accept" / "room", or null
//   projectFields(row)         -> extra fields for a score in list/info answers
import { json, fail, randomHex, sha256Hex, cleanName, readJson, scoreKey } from "./http.js";

const LOGIN_CODE_MINUTES = 5;
const MAX_UPLOAD = 18 * 1024 * 1024;
const INVITE_DAYS = 14;
const OWNED_LIST_MAX = 1000;
const SHARED_LIST_MAX = 300;

const shortId = (id) => String(id || "").replace(/^[up]_/, "").slice(0, 6);
const roomStub = (env, room) => env.ROOMS.get(env.ROOMS.idFromName(room));

//! Give the Room its first score (uploaded from the website or the app).
async function initRoomScore(env, projectId, room, title, bytes) {
    const r = await roomStub(env, room).fetch("https://room/init", {
        method: "POST",
        headers: { "X-Collab-Project-Id": projectId, "X-Collab-Title": encodeURIComponent(title) },
        body: bytes,
    });
    return r.ok;
}

//! The user's role in a project ("owner" | "editor"), or null.
export async function roleIn(env, projectId, userId) {
    const row = await env.DB.prepare("SELECT role FROM members WHERE project_id = ? AND user_id = ?")
        .bind(projectId, userId).first();
    return row ? row.role : null;
}

//! Delete a score for good: its invites, login codes, members and row, the saved file in R2,
//! and the live room's data. Returns true when this call removed the score (false if already gone).
export async function deleteScore(env, projectId) {
    const project = await env.DB.prepare("SELECT room FROM projects WHERE id = ?").bind(projectId).first();
    const results = await env.DB.batch([
        env.DB.prepare("DELETE FROM invites WHERE project_id = ?").bind(projectId),
        env.DB.prepare("DELETE FROM login_codes WHERE project_id = ?").bind(projectId),
        env.DB.prepare("DELETE FROM members WHERE project_id = ?").bind(projectId),
        env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
    ]);
    await env.SCORES.delete(scoreKey(projectId));
    if (project) {
        await roomStub(env, project.room).fetch("https://room/purge", { method: "POST" });
    }
    return results[3].meta.changes === 1;
}

//! Undo a create whose score couldn't be stored, so the slot isn't used up.
async function removeProject(env, projectId) {
    await env.DB.batch([
        env.DB.prepare("DELETE FROM members WHERE project_id = ?").bind(projectId),
        env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
    ]);
}

//! Create a project and its owner row. A limit (hooks.projectLimit) is checked inside the INSERT
//! itself (one statement), so parallel requests can't both take the last slot. The owner row is
//! added in the same batch (a transaction), only if the project went in.
export async function createProject(env, config, user, title, hooks = {}) {
    const limit = hooks.projectLimit ? hooks.projectLimit(user, config) : undefined;
    const projectId = `p_${randomHex(12)}`;
    const room = randomHex(16);
    const now = Date.now();
    const limited = Number.isFinite(limit);
    const insert = limited
        ? env.DB.prepare("INSERT INTO projects (id, owner_id, title, room, created_at, updated_at) "
            + "SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM projects WHERE owner_id = ?) < ?")
            .bind(projectId, user.id, title, room, now, now, user.id, limit)
        : env.DB.prepare("INSERT INTO projects (id, owner_id, title, room, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(projectId, user.id, title, room, now, now);
    const results = await env.DB.batch([
        insert,
        env.DB.prepare("INSERT INTO members (project_id, user_id, role, joined_at) "
            + "SELECT id, owner_id, 'owner', ? FROM projects WHERE id = ?").bind(now, projectId),
    ]);
    if (!results[0].meta.changes) {
        return { error: hooks.limitError ? hooks.limitError(limit, config) : fail(402, "You can't own more scores.") };
    }
    return { projectId, room, title };
}

//! Handles /api/projects... and invite accept for a signed-in user; null if the path isn't ours.
export async function handleProjects({ request, env, config, user, url, path, method, publicOrigin, hooks = {} }) {
    const fields = (row) => (hooks.projectFields ? hooks.projectFields(row) : {});
    const gate = (project, role, action) => (hooks.gate ? hooks.gate(project, role, action) : null);
    let m;

    if (path === "/api/projects" && method === "GET") {
        // Owned and shared are capped separately, so shared scores can never push owned ones off the list.
        const list = (owned, limit) => env.DB.prepare(
            "SELECT p.*, m.role FROM members m JOIN projects p ON p.id = m.project_id "
            + `WHERE m.user_id = ? AND ${owned ? "p.owner_id = ?" : "p.owner_id != ?"} ORDER BY p.updated_at DESC, p.id LIMIT ?`)
            .bind(user.id, user.id, limit).all();
        const [mine, shared] = await Promise.all([list(true, OWNED_LIST_MAX), list(false, SHARED_LIST_MAX)]);
        const rows = [...mine.results, ...shared.results].sort((a, b) => (b.updated_at - a.updated_at) || (a.id < b.id ? -1 : 1));
        return json({ projects: rows.map((r) => ({ projectId: r.id, title: r.title, updatedAt: r.updated_at, role: r.role, ...fields(r) })) });
    }

    if (path === "/api/projects" && method === "POST") {
        const body = await readJson(request);
        const p = await createProject(env, config, user, cleanName(body.title, 128) || "Untitled score", hooks);
        return p.error || json(p);
    }

    if (path === "/api/projects/upload" && method === "POST") {
        // Check the size before reading the body.
        const length = Number(request.headers.get("Content-Length") || "0");
        if (!length || length > MAX_UPLOAD) {
            return fail(413, "Scores can be up to 18 MB.");
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length < 4 || bytes.length > MAX_UPLOAD || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
            return fail(400, "That isn't a MuseScore (.mscz) file.");
        }
        // Only now take a slot, and give it back if the score can't be stored.
        const p = await createProject(env, config, user, cleanName(url.searchParams.get("title"), 128) || "Untitled score", hooks);
        if (p.error) {
            return p.error;
        }
        let stored = false;
        try {
            stored = await initRoomScore(env, p.projectId, p.room, p.title, bytes);
        } catch { /* treated as not stored */ }
        if (!stored) {
            await removeProject(env, p.projectId);
            return fail(500, "Couldn't store the score. Try again.");
        }
        return json(p);
    }

    m = path.match(/^\/api\/projects\/(p_[0-9a-f]{24})(\/.*)?$/);
    if (m) {
        const projectId = m[1];
        const sub = m[2] || "";
        const role = await roleIn(env, projectId, user.id);
        if (!role) {
            return fail(403, "You're not in this score. Ask its owner for an invite link.");
        }
        const ownerOnly = () => fail(403, "Only the score's owner can do that.");

        if (sub === "" && method === "GET") {
            const p = await env.DB.prepare("SELECT p.*, u.name AS owner_name FROM projects p "
                + "JOIN users u ON u.id = p.owner_id WHERE p.id = ?").bind(projectId).first();
            if (!p) {
                return fail(404, "not found");
            }
            return json({ projectId, title: p.title, role, ownerName: p.owner_name, updatedAt: p.updated_at, ...fields(p) });
        }

        // "Open in Ploq": a one-time link that signs the app in and opens the score.
        if (sub === "/open" && method === "POST") {
            const project = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
            const refused = project && gate(project, role, "open");
            if (refused) {
                return refused;
            }
            const code = randomHex(16);
            await env.DB.prepare("INSERT INTO login_codes (code_hash, user_id, project_id, purpose, expires_at) VALUES (?, ?, ?, 'open', ?)")
                .bind(await sha256Hex(code), user.id, projectId, Date.now() + LOGIN_CODE_MINUTES * 60_000).run();
            return json({ url: `ploq://open/${projectId}?code=${code}` });
        }

        if (sub === "/invites" && method === "POST") {
            if (role !== "owner") {
                return ownerOnly();
            }
            const code = randomHex(12);
            const now = Date.now();
            await env.DB.prepare("INSERT INTO invites (code, project_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
                .bind(code, projectId, user.id, now, now + INVITE_DAYS * 86400_000).run();
            return json({ code, url: `${publicOrigin}/j/${code}` });
        }

        if (sub === "/invites" && method === "DELETE") {
            if (role !== "owner") {
                return ownerOnly();
            }
            await env.DB.prepare("DELETE FROM invites WHERE project_id = ?").bind(projectId).run();
            return json({});
        }

        if (sub === "/members" && method === "GET") {
            const { results } = await env.DB.prepare(
                "SELECT u.id, u.name, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? "
                + "ORDER BY m.role = 'owner' DESC, m.joined_at").bind(projectId).all();
            return json({ members: results.map((r) => ({ userId: r.id, accountId: shortId(r.id), name: r.name, role: r.role })) });
        }

        const mm = sub.match(/^\/members\/(u_[0-9a-f]{24})$/);
        if (mm && method === "DELETE") {
            if (role !== "owner") {
                return ownerOnly();
            }
            if (mm[1] === user.id) {
                return fail(400, "You own this score. Delete it instead.");
            }
            await env.DB.prepare("DELETE FROM members WHERE project_id = ? AND user_id = ?").bind(projectId, mm[1]).run();
            // Their invite link would let them straight back in: turn the score's links off. The owner
            // makes a new one for the people they still want to invite.
            await env.DB.prepare("DELETE FROM invites WHERE project_id = ?").bind(projectId).run();
            const project = await env.DB.prepare("SELECT room FROM projects WHERE id = ?").bind(projectId).first();
            if (project) {
                await roomStub(env, project.room).fetch("https://room/kick", { method: "POST", headers: { "X-Collab-User-Id": mm[1] } });
            }
            return json({ invitesRevoked: true });
        }

        if (sub === "" && method === "DELETE") {
            if (role !== "owner") {
                return ownerOnly();
            }
            await deleteScore(env, projectId);
            return json({});
        }

        return fail(404, "not found");
    }

    m = path.match(/^\/api\/invites\/([0-9a-f]{24})\/accept$/);
    if (m && method === "POST") {
        const inv = await env.DB.prepare(
            "SELECT p.*, i.project_id, i.expires_at FROM invites i JOIN projects p ON p.id = i.project_id WHERE i.code = ?")
            .bind(m[1]).first();
        if (!inv || inv.expires_at < Date.now()) {
            return fail(404, "This invite link isn't valid. It may have expired or been turned off.");
        }
        const refused = gate(inv, null, "accept");
        if (refused) {
            return refused;
        }
        await env.DB.prepare("INSERT OR IGNORE INTO members (project_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)")
            .bind(inv.project_id, user.id, Date.now()).run();
        return json({ projectId: inv.project_id, room: inv.room, title: inv.title });
    }

    return null;
}
