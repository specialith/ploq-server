// Settings, read from the Worker's environment (wrangler.jsonc vars, .dev.vars or --var).
// A Ploq server signs people in by name: the first account is the owner, everyone after
// that joins through an invite link.

// Score limits, so invited accounts can't fill the server's storage (each score keeps up to ~18 MB
// in R2). SCORE_LIMIT: scores each invited account may own (the server's owner has no limit).
// SERVER_SCORE_LIMIT: scores on the whole server (500 x 18 MB stays inside R2's free 10 GB).
// A whole number, or "unlimited".
const DEFAULT_SCORE_LIMIT = 20;
const DEFAULT_SERVER_SCORE_LIMIT = 500;

function limitVar(value, fallback) {
    const v = String(value ?? "").trim().toLowerCase();
    if (v === "") {
        return fallback;
    }
    if (v === "unlimited") {
        return Infinity;
    }
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function getConfig(env = {}) {
    const publicOrigin = String(env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
    let host = "";
    try {
        host = new URL(publicOrigin).hostname;
    } catch { /* no usable origin */ }
    return {
        mode: "self-host",
        hosted: false,
        authMethods: new Set(["name"]),
        // Test-only routes; honored only on a local server.
        devTools: env.DEV_TOOLS === "1" && (host === "localhost" || host === "127.0.0.1"),
        publicOrigin,
        scoreLimit: limitVar(env.SCORE_LIMIT, DEFAULT_SCORE_LIMIT),
        serverScoreLimit: limitVar(env.SERVER_SCORE_LIMIT, DEFAULT_SERVER_SCORE_LIMIT),
    };
}
