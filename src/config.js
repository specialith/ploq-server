// Settings, read from the Worker's environment (wrangler.jsonc vars, .dev.vars or --var).
// A Ploq server signs people in by name: the first account is the owner, everyone after
// that joins through an invite link.

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
    };
}
