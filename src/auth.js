// Sign-in: by name. The first account on a server is free (it's the owner); after that, a new
// account needs a valid invite link. Also sign-out, and device links (a one-time link from a
// signed-in browser that signs another browser in to the same account).

import { json, fail, randomHex, sha256Hex, cleanName, readJson, allowed, clientIp } from "./http.js";
import { startSession, withCookie, clearedCookie, createUserWithSession } from "./session.js";

export const NEEDS_INVITE = "You need an invite link to join this server.";
const DEVICE_LINK_MINUTES = 15;

//! The live invite with this code ({project_id}), or null.
export async function validInvite(env, code) {
    const c = typeof code === "string" ? code.trim() : "";
    return /^[0-9a-f]{24}$/.test(c)
        ? env.DB.prepare("SELECT project_id FROM invites WHERE code = ? AND expires_at >= ?").bind(c, Date.now()).first()
        : null;
}

//! POST /api/signup {name, invite?}: name sign-in. The first account is free; after that you need
//! a valid invite code (and you join its score).
export async function signup(request, env, config) {
    if (!config.authMethods.has("name")) {
        return fail(404, "not found");
    }
    if (!(await allowed(env.SIGNUP_LIMITER, clientIp(request)))) {
        return fail(429, "Too many sign-ups from here. Wait a minute and try again.");
    }
    const body = await readJson(request);
    const name = cleanName(body.name, 40);
    if (!name) {
        return fail(400, "Type a name.");
    }
    const invite = await validInvite(env, body.invite);

    let created;
    if (invite) {
        created = await createUserWithSession(env, name);
        await env.DB.prepare("INSERT OR IGNORE INTO members (project_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)")
            .bind(invite.project_id, created.userId, Date.now()).run();
    } else {
        // Insert only while the table is empty, in one statement, so two first sign-ups can't both win.
        const userId = `u_${randomHex(12)}`;
        const res = await env.DB.prepare(
            "INSERT INTO users (id, name, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)")
            .bind(userId, name, Date.now()).run();
        if (!res.meta || !res.meta.changes) {
            return fail(403, NEEDS_INVITE);
        }
        created = { userId, name, ...(await startSession(env, userId, "web")) };
    }
    return withCookie(json({ userId: created.userId, name, token: created.token }), created.cookie);
}

//! POST /api/signout: this sign-in stops working and the cookie is cleared.
export async function signout(env, user) {
    await env.DB.prepare("DELETE FROM tokens WHERE token_hash = ?").bind(user.token_hash).run();
    return withCookie(json({}), clearedCookie());
}

//! POST /api/device-link: a one-time link that signs another browser in as this user.
export async function createDeviceLink(env, user, origin) {
    const code = randomHex(16);
    await env.DB.prepare("INSERT INTO login_codes (code_hash, user_id, project_id, purpose, expires_at) VALUES (?, ?, NULL, 'device', ?)")
        .bind(await sha256Hex(code), user.id, Date.now() + DEVICE_LINK_MINUTES * 60_000).run();
    return json({ url: `${origin}/device/${code}` });
}

const DEVICE_EXPIRED = "This link has expired. Create a new one.";

//! GET /api/device/<code>: whose account a device link signs in to, so the
//! page can say so before asking. No side effects: the link stays usable.
export async function previewDeviceLink(request, env, code) {
    if (!(await allowed(env.LOGIN_LIMITER, clientIp(request)))) {
        return fail(429, "Too many attempts. Wait a minute and try again.");
    }
    const row = await env.DB.prepare(
        "SELECT u.id, u.name FROM login_codes c JOIN users u ON u.id = c.user_id "
        + "WHERE c.code_hash = ? AND c.purpose = 'device' AND c.expires_at >= ?")
        .bind(await sha256Hex(code), Date.now()).first();
    if (!row) {
        return fail(404, DEVICE_EXPIRED);
    }
    return json({ name: row.name, accountId: String(row.id).replace(/^u_/, "").slice(0, 6) });
}

//! POST /api/device/<code>: redeem a device link once and start a browser session.
export async function redeemDeviceLink(request, env, code) {
    if (!(await allowed(env.LOGIN_LIMITER, clientIp(request)))) {
        return fail(429, "Too many attempts. Wait a minute and try again.");
    }
    // One statement deletes and returns the code, so two requests can't both redeem it.
    const row = await env.DB.prepare(
        "DELETE FROM login_codes WHERE code_hash = ? AND purpose = 'device' AND expires_at >= ? RETURNING user_id")
        .bind(await sha256Hex(code), Date.now()).first();
    await env.DB.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(Date.now()).run();
    const user = row && await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(row.user_id).first();
    if (!user) {
        return fail(404, DEVICE_EXPIRED);
    }
    const session = await startSession(env, row.user_id, "web");
    return withCookie(json({ name: user.name }), session.cookie);
}
