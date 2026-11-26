// Runs an HTTP test file against a server with a brand-new database:
//   node scripts/test-fresh.mjs --test test/selfhost.test.mjs --port 8799 --url-var SELFHOST_URL
//     [--config wrangler.jsonc] [--var NAME:value ...]
// Deletes .wrangler/test-<port>, migrates it, starts `wrangler dev` on that port with
// DEV_TOOLS=1 and PUBLIC_ORIGIN set to it, runs the tests (with the server's address in the
// --url-var environment variable), stops the server. Aborts if the port is taken.

import { spawn, spawnSync } from "node:child_process";
import { rmSync, readdirSync, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const one = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const vars = args.flatMap((a, i) => (a === "--var" ? [args[i + 1]] : []));
const testFile = one("--test");
const port = Number(one("--port", "8799"));
const urlVar = one("--url-var", "SELFHOST_URL");
const config = one("--config");
if (!testFile || !port) {
    console.error("usage: node scripts/test-fresh.mjs --test <file> --port <n> [--url-var NAME] [--config file] [--var NAME:value ...]");
    process.exit(2);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
// A new folder each run: on Windows a server that just stopped can hold the last run's files for
// a few seconds. Old run folders are removed when they can be.
const persist = `.wrangler/test-${port}-${process.pid}`;
const url = `http://127.0.0.1:${port}`;
const cfg = config ? ["-c", config] : [];

// Something already listening here would answer /health and we'd test the wrong server.
const portInUse = () => new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
});
if (await portInUse()) {
    console.error(`Port ${port} is already in use. Stop whatever is running there and try again.`);
    process.exit(1);
}

for (const old of existsSync(`${root}/.wrangler`) ? readdirSync(`${root}/.wrangler`, { withFileTypes: true }) : []) {
    if (old.isDirectory() && old.name.startsWith(`test-${port}`)) {
        try { rmSync(`${root}/.wrangler/${old.name}`, { recursive: true, force: true }); } catch { /* still in use: next time */ }
    }
}
const mig = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist, ...cfg],
                      { cwd: root, stdio: "inherit" });
if (mig.status !== 0) {
    process.exit(mig.status || 1);
}

const server = spawn(process.execPath, [wrangler, "dev", ...cfg, "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist,
    "--var", "DEV_TOOLS:1", "--var", `PUBLIC_ORIGIN:${url}`, ...vars.flatMap((v) => ["--var", v])],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
try { os.setPriority(server.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }

const stop = () => {
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
        server.kill();
    }
};
let code = 1;
try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
        try { up = (await fetch(`${url}/health`)).ok; } catch { /* not up yet */ }
        if (!up) {
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    if (!up) {
        throw new Error("wrangler dev did not start");
    }
    const run = spawnSync(process.execPath, ["--test", testFile],
                          { cwd: root, stdio: "inherit", env: { ...process.env, [urlVar]: url } });
    code = run.status ?? 1;
} catch (e) {
    console.error(e.message);
} finally {
    stop();
    // Wait until the port is free, so the next run (or a run right after this one) starts clean.
    for (let i = 0; i < 40 && await portInUse(); i++) {
        await new Promise((r) => setTimeout(r, 250));
    }
}
process.exit(code);
