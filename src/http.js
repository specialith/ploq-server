// Small HTTP and encoding helpers shared by the Worker modules.

// Security headers on every response (HSTS: browsers only ever use https here).
export const SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "strict-transport-security": "max-age=31536000",
};

export function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS },
    });
}

export const fail = (status, error) => json({ error }, status);

//! Where a score's saved .mscz lives in R2.
export const scoreKey = (projectId) => `scores/${projectId}.mscz`;

export function randomHex(bytes) {
    const b = crypto.getRandomValues(new Uint8Array(bytes));
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomToken() {
    const b = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64url(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

export function bytesToBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

// Names and titles: no control characters, and no invisible direction /
// zero-width characters that could make one name look like another.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g;
// Half of a surrogate pair with no other half: not a character, and encodeURIComponent throws on it.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
//! Cut by code point (max characters, not UTF-16 units), so an emoji is never split in two.
export const cleanName = (v, max) => Array.from(String(v ?? "").replace(INVISIBLE, "").replace(LONE_SURROGATE, "").trim())
    .slice(0, max).join("").trimEnd();

export async function readJson(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

//! Rate limit; a missing binding (e.g. an older local setup) means "allow".
export async function allowed(limiter, key) {
    if (!limiter) {
        return true;
    }
    const { success } = await limiter.limit({ key });
    return success;
}

export const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "local";

export function bearer(request) {
    const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/);
    return m ? m[1] : null;
}

//! A path to send the browser back to after sign-in. Only site paths pass;
//! anything that could leave the site (other hosts, "//host", "/\host",
//! schemes, control characters that browsers strip) becomes "/".
export function safeReturnPath(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) {
        return "/scores";
    }
    if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
        return "/scores";
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) {
        return "/scores";
    }
    return value;
}

//! One cookie's value from the request, or null.
export function cookieValue(request, name) {
    for (const part of (request.headers.get("Cookie") || "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0 && part.slice(0, i).trim() === name) {
            return part.slice(i + 1).trim() || null;
        }
    }
    return null;
}
