// Sign-in sessions. A session is a random token; only its SHA-256 is stored.
// Browsers keep it in the ploq_session cookie, the app sends it as a Bearer token.

import { randomHex, randomToken, sha256Hex, bearer, cookieValue } from "./http.js";

export const COOKIE_NAME = "ploq_session";
const TOKEN_DAYS = 180;                     // sign-ins expire; sign in again after
const COOKIE_ATTRS = "HttpOnly; Secure; SameSite=Lax; Path=/";

export const sessionCookie = (token) => `${COOKIE_NAME}=${token}; ${COOKIE_ATTRS}; Max-Age=${TOKEN_DAYS * 86400}`;
export const clearedCookie = () => `${COOKIE_NAME}=; ${COOKIE_ATTRS}; Max-Age=0`;

//! The signed-in user: their users row (id, name, ... whatever columns the database has),
//! plus token_hash and via: "bearer" | "cookie"; or null.
export async function userFromRequest(request, env) {
    let token = bearer(request);
    let via = "bearer";
    if (!token) {
        token = cookieValue(request, COOKIE_NAME);
        via = "cookie";
    }
    if (!token) {
        return null;
    }
    const user = await env.DB.prepare(
        "SELECT u.*, t.token_hash FROM tokens t JOIN users u ON u.id = t.user_id "
        + "WHERE t.token_hash = ? AND t.created_at > ?")
        .bind(await sha256Hex(token), Date.now() - TOKEN_DAYS * 86400_000).first();
    return user ? { ...user, via } : null;
}

//! A new sign-in for `userId`. kind: "web" (browser) or "app". Returns the
//! token and the Set-Cookie value for browser responses.
export async function startSession(env, userId, kind = "app") {
    const token = randomToken();
    await env.DB.prepare("INSERT INTO tokens (token_hash, user_id, created_at, kind) VALUES (?, ?, ?, ?)")
        .bind(await sha256Hex(token), userId, Date.now(), kind).run();
    return { token, cookie: sessionCookie(token) };
}

//! Same response with a Set-Cookie header added.
export function withCookie(response, cookie) {
    const r = new Response(response.body, response);
    r.headers.append("Set-Cookie", cookie);
    return r;
}

//! A new user plus a browser session: {userId, name, token, cookie}.
export async function createUserWithSession(env, name) {
    const userId = `u_${randomHex(12)}`;
    await env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)")
        .bind(userId, name, Date.now()).run();
    return { userId, name, ...(await startSession(env, userId, "web")) };
}
