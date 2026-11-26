// Ploq server: the HTTP side of the Worker.
//
// One Durable Object ("Room", room.js) per shared score orders edits, tracks who's connected
// and brings late joiners up to date. Accounts, scores (projects), members and invite links are
// in D1; each score's saved file is in R2. Only signed-in members of a score can open its room.
// The website (site.js + public/) is served from the same address.
//
// HTTP API (JSON; "*" = signed in: the app sends "Authorization: Bearer <token>", the website a cookie):
//   POST   /api/signup                {name, invite?} -> {userId, name, token}  (sets cookie)
//   POST   /api/signout                    *        -> {} (this sign-in stops working)
//   GET    /api/me                          *        -> {userId, name, mode, authMethods}
//                                                     (signed out: 401 {error, mode, authMethods}, for the sign-in page)
//   POST   /api/app-signin                  * {state, challenge} -> {url: ploq://signin?...}  (website -> app sign-in)
//   POST   /api/device-link                 *        -> {url}  (one-time, 15 min: signs another browser in)
//   GET    /api/device/<code>                        -> {name, accountId}  (preview, no side effects)
//   POST   /api/device/<code>                        -> {name}  (sets cookie; single use)
//   GET    /health                                   -> text (liveness)
//   GET    /api/invites/<code>                       -> {title, inviter, inviterId}
//   POST   /api/invites/<code>/accept       *        -> {projectId, room, title}
//   GET    /api/login/<code>                         -> {name, accountId, title}  (preview, no side effects)
//   POST   /api/login/<code>                         -> {token, userId, name, project}  (single use)
//   GET    /api/projects                    *        -> {projects}
//   POST   /api/projects                    * {title} -> {projectId, room, title}
//   POST   /api/projects/upload?title=      * .mscz  -> {projectId, room, title}
//   GET    /api/projects/<id>               *        -> {projectId, title, role, ownerName, updatedAt}
//   POST   /api/projects/<id>/open          *        -> {url: ploq://open/...}
//   POST   /api/projects/<id>/invites       * owner  -> {code, url}
//   DELETE /api/projects/<id>/invites       * owner  -> {} (all invite links stop working)
//   GET    /api/projects/<id>/members       *        -> {members}
//   DELETE /api/projects/<id>/members/<uid> * owner  -> {}
//   DELETE /api/projects/<id>               * owner  -> {} (deletes the score for everyone)
//   GET    /room/<room>                     * WebSocket (members only)
// The socket protocol is described in ploq-app (docs/collab/PROTOCOL.md).
//
// createApp(ext) lets a deployment add to this without changing it (all optional):
//   getConfig(env), site {pages, scripts}, requestConfig(c) -> extra config for this request,
//   before(c) (before pages and the Origin rules), publicRoutes(c) (after the Origin rules, before
//   sign-in), routes(c) (signed in), projects (hooks, see projects.js), scheduled(event, env, ctx).
//   Each route hook returns a Response, or null to carry on.

import { siteResponse } from "./site.js";
import { getConfig as coreConfig } from "./config.js";
import { handleProjects, roleIn } from "./projects.js";
import { SECURITY_HEADERS, json, fail, randomHex, sha256Hex, sha256Base64url, cleanName, readJson, allowed, clientIp } from "./http.js";
import { userFromRequest, startSession, withCookie, createUserWithSession } from "./session.js";
import { signup, signout, createDeviceLink, previewDeviceLink, redeemDeviceLink } from "./auth.js";

const LOGIN_CODE_MINUTES = 5;

const roomStub = (env, room) => env.ROOMS.get(env.ROOMS.idFromName(room));
const shortId = (id) => String(id || "").replace(/^[up]_/, "").slice(0, 6);

export function createApp(ext = {}) {
    const getConfig = ext.getConfig || coreConfig;
    const hooks = ext.projects || {};
    const gate = (project, role, action) => (hooks.gate ? hooks.gate(project, role, action) : null);

    return {
        async scheduled(event, env, ctx) {
            if (ext.scheduled) {
                await ext.scheduled(event, env, ctx);
            }
        },

        async fetch(request, env, ctx) {
            const url = new URL(request.url);
            const path = url.pathname;
            const method = request.method;
            const PUBLIC_ORIGIN = (env.PUBLIC_ORIGIN || url.origin).replace(/\/+$/, "");
            const c = { request, env, ctx, url, path, method, PUBLIC_ORIGIN, config: getConfig(env) };
            c.config = { ...c.config, publicOrigin: PUBLIC_ORIGIN, ...(ext.requestConfig ? ext.requestConfig(c) : {}) };
            const config = c.config;
            let m;
            let r;

            if (ext.before && (r = await ext.before(c))) {
                return r;
            }
            if (method === "GET" || method === "HEAD") {
                const page = siteResponse(path, ext.site);
                if (page) {
                    return page;
                }
            }
            if (path === "/health") {
                return new Response("collab sync server\n", { headers: { "content-type": "text/plain", ...SECURITY_HEADERS } });
            }

            // Browsers may only call the API from this site's own pages; other
            // origins are refused (CSRF / socket hijacking). The app sends no Origin.
            const origin = request.headers.get("Origin");
            if (origin && origin !== url.origin) {
                return fail(403, "forbidden");
            }
            if (origin && path.startsWith("/room/")) {
                return fail(403, "forbidden"); // rooms are for the app
            }
            // Requests that set a session cookie without one being sent must come from this
            // site's own pages (else a page elsewhere could sign a visitor into its account).
            c.origin = origin;
            c.siteOnly = () => (origin === url.origin ? null : fail(403, "forbidden"));

            if (path === "/api/signup" && method === "POST") {
                return c.siteOnly() || signup(request, env, config);
            }
            if (ext.publicRoutes && (r = await ext.publicRoutes(c))) {
                return r;
            }

            // Test-only sign-in: creates a user and token. 404 unless DEV_TOOLS=1 on localhost.
            if (path === "/api/dev/signin" && method === "POST") {
                if (!config.devTools) {
                    return fail(404, "not found");
                }
                const body = await readJson(request);
                const name = cleanName(body.name, 40);
                if (!name) {
                    return fail(400, "Type a name.");
                }
                const created = await createUserWithSession(env, name);
                return withCookie(json({ userId: created.userId, name, token: created.token }), created.cookie);
            }

            // Invite details for the invite page (no sign-in needed).
            m = path.match(/^\/api\/invites\/([0-9a-f]{24})$/);
            if (m && method === "GET") {
                const inv = await env.DB.prepare(
                    "SELECT p.title, u.name AS inviter, u.id AS inviter_id, i.expires_at FROM invites i "
                    + "JOIN projects p ON p.id = i.project_id JOIN users u ON u.id = i.created_by WHERE i.code = ?").bind(m[1]).first();
                if (!inv || inv.expires_at < Date.now()) {
                    return fail(404, "This invite link isn't valid. It may have expired or been turned off.");
                }
                return json({ title: inv.title, inviter: inv.inviter, inviterId: shortId(inv.inviter_id) });
            }

            // "Open in Ploq" and app sign-in codes: preview (so the app can ask first), then redeem once.
            m = path.match(/^\/api\/login\/([0-9a-f]{32})$/);
            if (m && (method === "GET" || method === "POST")) {
                if (!(await allowed(env.LOGIN_LIMITER, clientIp(request)))) {
                    return fail(429, "Too many attempts. Wait a minute and try again.");
                }
                const hash = await sha256Hex(m[1]);
                const expired = fail(404, "This link has expired. Click \"Open in Ploq\" on the website again.");
                if (method === "GET") {
                    // u.*: the preview includes the account's email where the database has one.
                    const row = await env.DB.prepare(
                        "SELECT u.*, p.title AS project_title FROM login_codes c JOIN users u ON u.id = c.user_id "
                        + "LEFT JOIN projects p ON p.id = c.project_id WHERE c.code_hash = ? AND c.expires_at >= ? "
                        + "AND (c.purpose = 'app' OR (c.purpose = 'open' AND p.id IS NOT NULL))").bind(hash, Date.now()).first();
                    return row ? json({ name: row.name, email: row.email, accountId: shortId(row.id), title: row.project_title || null }) : expired;
                }
                const now = Date.now();
                const peek = await env.DB.prepare(
                    "SELECT purpose, challenge FROM login_codes WHERE code_hash = ? AND expires_at >= ?").bind(hash, now).first();
                if (!peek || (peek.purpose !== "open" && peek.purpose !== "app")) {
                    return expired;
                }
                if (peek.purpose === "app") {
                    // A wrong or missing verifier must not use the code up.
                    const body = await readJson(request);
                    const verifier = body && typeof body.verifier === "string" ? body.verifier : "";
                    if (!verifier || verifier.length > 256 || (await sha256Base64url(verifier)) !== peek.challenge) {
                        return expired;
                    }
                }
                // One statement deletes and returns the code, so two requests can't both redeem it.
                const code = await env.DB.prepare(
                    "DELETE FROM login_codes WHERE code_hash = ? AND purpose = ? AND expires_at >= ? RETURNING user_id, project_id")
                    .bind(hash, peek.purpose, now).first();
                await env.DB.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(now).run();
                if (!code) {
                    return expired;
                }
                if (peek.purpose === "app") {
                    const u = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(code.user_id).first();
                    if (!u) {
                        return expired;
                    }
                    const { token } = await startSession(env, code.user_id, "app");
                    return json({ token, userId: code.user_id, name: u.name });
                }
                const row = await env.DB.prepare(
                    "SELECT u.name, p.room, p.title FROM users u, projects p WHERE u.id = ? AND p.id = ?")
                    .bind(code.user_id, code.project_id).first();
                if (!row) {
                    return expired;
                }
                const { token } = await startSession(env, code.user_id, "app");
                return json({ token, userId: code.user_id, name: row.name,
                              project: { projectId: code.project_id, room: row.room, title: row.title } });
            }

            // Device links ("Sign in on another computer"): preview, then redeem once (sets the cookie).
            m = path.match(/^\/api\/device\/([0-9a-f]{32})$/);
            if (m && method === "GET") {
                return previewDeviceLink(request, env, m[1]);
            }
            if (m && method === "POST") {
                return c.siteOnly() || redeemDeviceLink(request, env, m[1]);
            }

            const user = await userFromRequest(request, env);
            if (!user && path === "/api/me" && method === "GET") {
                // Signed out: the sign-in page still needs to know which ways to sign in this server offers.
                return json({ error: "Sign in first.", mode: config.mode, authMethods: [...config.authMethods] }, 401);
            }
            if (!user && (path.startsWith("/api/") || path.startsWith("/room/"))) {
                return fail(401, "Sign in first.");
            }
            // Cookie sign-ins (browsers) may only change things from this site's own pages.
            // Bearer sign-ins (the app) send no Origin.
            if (user && user.via === "cookie" && method !== "GET" && method !== "HEAD" && origin !== url.origin) {
                return fail(403, "forbidden");
            }
            // Changes (not reads, not the live room) are rate limited per person.
            if (method !== "GET" && path.startsWith("/api/") && !(await allowed(env.WRITE_LIMITER, user.id))) {
                return fail(429, "That's a lot of changes at once. Wait a minute and try again.");
            }
            c.user = user;
            if (ext.routes && (r = await ext.routes(c))) {
                return r;
            }

            if (path === "/api/signout" && method === "POST") {
                return signout(env, user);
            }

            if (path === "/api/device-link" && method === "POST") {
                return createDeviceLink(env, user, config.siteOrigin || PUBLIC_ORIGIN);
            }

            if (path === "/api/app-signin" && method === "POST") {
                const body = await readJson(request);
                const st = body && body.state;
                const ch = body && body.challenge;
                if (typeof st !== "string" || !/^[0-9a-f]{32}$/.test(st) || typeof ch !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ch)) {
                    return fail(400, "That sign-in link isn't valid. Start again from Ploq.");
                }
                const code = randomHex(16);
                await env.DB.prepare("INSERT INTO login_codes (code_hash, user_id, project_id, purpose, expires_at, state, challenge) VALUES (?, ?, NULL, 'app', ?, ?, ?)")
                    .bind(await sha256Hex(code), user.id, Date.now() + LOGIN_CODE_MINUTES * 60_000, st, ch).run();
                return json({ url: `ploq://signin?state=${st}&code=${code}` });
            }

            if (path === "/api/me" && method === "GET") {
                return json({ userId: user.id, name: user.name, mode: config.mode, authMethods: [...config.authMethods] });
            }

            const handled = await handleProjects({ request, env, config, user, url, path, method, publicOrigin: PUBLIC_ORIGIN, hooks });
            if (handled) {
                return handled;
            }

            m = path.match(/^\/room\/([0-9a-f]{32})$/);
            if (m) {
                if (request.headers.get("Upgrade") !== "websocket") {
                    return fail(426, "expected a WebSocket upgrade");
                }
                const project = await env.DB.prepare("SELECT * FROM projects WHERE room = ?").bind(m[1]).first();
                if (!project) {
                    return fail(404, "no such room");
                }
                const role = await roleIn(env, project.id, user.id);
                if (!role) {
                    return fail(403, "not a member of this project");
                }
                const refused = gate(project, role, "room");
                if (refused) {
                    return refused;
                }
                // Tell the room who this is (headers we set; anything the client sent is replaced).
                const headers = new Headers(request.headers);
                headers.set("X-Collab-User-Id", user.id);
                headers.set("X-Collab-User-Name", encodeURIComponent(user.name));
                headers.set("X-Collab-Project-Id", project.id);
                return roomStub(env, m[1]).fetch(new Request(request, { headers }));
            }

            return fail(404, "not found");
        },
    };
}
