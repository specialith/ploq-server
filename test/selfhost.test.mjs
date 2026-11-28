// Tests for the server against a fresh database: name sign-in, cookies, device links, and that
// there are no plans or billing.
//
// The first-account rule means this MUST run against a freshly migrated
// database. `npm run test:server` does that: it deletes .wrangler/test-8799,
// migrates it, starts `wrangler dev` on 8799 with that data, runs this file and
// stops the server. Running the file by hand against a used database fails.
// It also sets SETUP_CODE=test-setup-code, SCORE_LIMIT=3 and SERVER_SCORE_LIMIT=20.
//
//   SELFHOST_URL (default http://127.0.0.1:8799)

import test from "node:test";
import assert from "node:assert/strict";

const base = process.env.SELFHOST_URL || "http://127.0.0.1:8799";
const origin = new URL(base).origin;

const call = async (path, { method = "GET", token, cookie, body, headers = {} } = {}) => {
    const r = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body ? { "content-type": "application/json" } : {}),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, setCookie: r.headers.get("set-cookie") };
};
const cookieOf = (setCookie) => setCookie.split(";")[0];
const COOKIE_RE = /^ploq_session=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=15552000$/;

const SITE = { Origin: origin };
const state = {};

test("signed out, /api/me is 401 and names the ways to sign in (for the sign-in page)", async () => {
    const r = await call("/api/me");
    assert.equal(r.status, 401);
    assert.deepEqual(r.data, { error: "Sign in first.", mode: "self-host", authMethods: ["name"] });
});

test("the first sign-up needs the server's setup code", async () => {
    // Otherwise whoever finds a new server before its deployer does becomes its owner.
    // From another address: sign-ups are limited to 5 a minute from each.
    const EARLY = { ...SITE, "CF-Connecting-IP": "10.50.0.1" };
    const none = await call("/api/signup", { method: "POST", headers: EARLY, body: { name: "Early Bird" } });
    assert.equal(none.status, 403);
    assert.equal(none.data.setup, "needed");
    assert.equal(none.setCookie, null);
    const wrong = await call("/api/signup", { method: "POST", headers: EARLY, body: { name: "Early Bird", setupCode: "test-setup-cod" } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.data.setup, "needed");
    assert.equal(wrong.data.error, "That setup code isn't right.");
    // An invite that doesn't exist doesn't get around it.
    const inv = await call("/api/signup", { method: "POST", headers: EARLY, body: { name: "Early Bird", invite: "0".repeat(24) } });
    assert.equal(inv.status, 403);
    assert.equal(inv.data.setup, "needed");
});

test("the first sign-up with the setup code makes the owner and sets the session cookie", async () => {
    const r = await call("/api/signup", { method: "POST", headers: SITE, body: { name: "Admin", setupCode: " test-setup-code " } });
    assert.equal(r.status, 200);
    assert.equal(r.data.name, "Admin");
    assert.ok(r.data.token && r.data.userId);
    assert.match(r.setCookie, COOKIE_RE);
    assert.equal(cookieOf(r.setCookie), `ploq_session=${r.data.token}`);
    state.admin = r.data;
    state.adminCookie = cookieOf(r.setCookie);
});

test("a second sign-up without an invite is refused, setup code or not", async () => {
    const r = await call("/api/signup", { method: "POST", headers: SITE, body: { name: "Mallory" } });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "You need an invite link to join this server.");
    assert.equal(r.data.setup, undefined);
    const again = await call("/api/signup", { method: "POST", headers: { ...SITE, "CF-Connecting-IP": "10.50.0.2" }, body: { name: "Mallory", setupCode: "test-setup-code" } });
    assert.equal(again.status, 403);
    assert.equal(again.data.error, "You need an invite link to join this server.");
    const bad = await call("/api/signup", { method: "POST", headers: SITE, body: { name: "Mallory", invite: "0".repeat(24) } });
    assert.equal(bad.status, 403);
});

test("a sign-up with a valid invite joins that score", async () => {
    const p = await call("/api/projects", { method: "POST", token: state.admin.token, body: { title: "Shared" } });
    assert.equal(p.status, 200);
    const inv = await call(`/api/projects/${p.data.projectId}/invites`, { method: "POST", token: state.admin.token });
    assert.equal(inv.status, 200);
    const r = await call("/api/signup", { method: "POST", headers: SITE, body: { name: "Bob", invite: inv.data.code } });
    assert.equal(r.status, 200);
    state.bob = r.data;
    const list = await call("/api/projects", { token: r.data.token });
    assert.deepEqual(list.data.projects.map((x) => [x.projectId, x.role]), [[p.data.projectId, "editor"]]);
});

test("cookie requests that change things must come from the site's own origin", async () => {
    const post = (headers) => call("/api/projects", { method: "POST", cookie: state.adminCookie, body: { title: "From cookie" }, headers });
    assert.equal((await post({ Origin: "https://evil.example" })).status, 403);
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ Origin: origin })).status, 200);
    // Reads by cookie need no Origin; Bearer (the app) needs none either.
    assert.equal((await call("/api/me", { cookie: state.adminCookie })).status, 200);
    assert.equal((await call("/api/projects", { method: "POST", token: state.admin.token, body: { title: "From app" } })).status, 200);
});

test("a device link signs a second browser in once", async () => {
    const link = await call("/api/device-link", { method: "POST", token: state.admin.token });
    assert.equal(link.status, 200);
    const m = link.data.url.match(/^(.+)\/device\/([0-9a-f]{32})$/);
    assert.ok(m, link.data.url);
    assert.equal(m[1], origin);
    const first = await call(`/api/device/${m[2]}`, { method: "POST", headers: SITE });
    assert.equal(first.status, 200);
    assert.equal(first.data.name, "Admin");
    assert.match(first.setCookie, COOKIE_RE);
    assert.equal((await call("/api/me", { cookie: cookieOf(first.setCookie) })).data.name, "Admin");
    assert.equal((await call(`/api/device/${m[2]}`, { method: "POST", headers: SITE })).status, 404);
});

test("a device link preview names the account and does not use up the link", async () => {
    // The /device page shows whose account it is before asking, so a link made
    // by someone else can't quietly sign the reader in to their account.
    const link = await call("/api/device-link", { method: "POST", token: state.admin.token });
    const code = link.data.url.split("/").pop();
    for (let i = 0; i < 2; i++) {
        const peek = await call(`/api/device/${code}`);
        assert.equal(peek.status, 200);
        assert.deepEqual(Object.keys(peek.data).sort(), ["accountId", "name"]);
        assert.equal(peek.data.name, "Admin");
        assert.equal(peek.data.accountId, state.admin.userId.replace(/^u_/, "").slice(0, 6));
        assert.equal(peek.setCookie, null);
    }
    const redeem = await call(`/api/device/${code}`, { method: "POST", headers: SITE });
    assert.equal(redeem.status, 200);
    assert.equal(redeem.data.name, "Admin");
    const again = await call(`/api/device/${code}`, { method: "POST", headers: SITE });
    assert.equal(again.status, 404);
    assert.equal(again.data.error, "This link has expired. Create a new one.");
    // Used up: the preview says so too.
    const used = await call(`/api/device/${code}`);
    assert.equal(used.status, 404);
    assert.equal(used.data.error, "This link has expired. Create a new one.");
});

test("a device link preview of an unknown code is 404", async () => {
    const r = await call(`/api/device/${"0".repeat(32)}`);
    assert.equal(r.status, 404);
    assert.equal(r.data.error, "This link has expired. Create a new one.");
    // An Open-in-Ploq code is not a device code.
    const p = await call("/api/projects", { method: "POST", token: state.admin.token, body: { title: "Preview" } });
    const o = await call(`/api/projects/${p.data.projectId}/open`, { method: "POST", token: state.admin.token });
    const openCode = o.data.url.match(/code=([0-9a-f]{32})$/)[1];
    assert.equal((await call(`/api/device/${openCode}`)).status, 404);
    assert.equal((await call(`/api/login/${openCode}`)).status, 200); // still a good Open-in-Ploq code
});

test("a device code is not an Open-in-Ploq code", async () => {
    const link = await call("/api/device-link", { method: "POST", token: state.admin.token });
    const code = link.data.url.split("/").pop();
    assert.equal((await call(`/api/login/${code}`, { method: "POST" })).status, 404);
});

test("signing out ends the session and clears the cookie", async () => {
    const link = await call("/api/device-link", { method: "POST", token: state.admin.token });
    const s = await call(`/api/device/${link.data.url.split("/").pop()}`, { method: "POST", headers: SITE });
    const cookie = cookieOf(s.setCookie);
    const out = await call("/api/signout", { method: "POST", cookie, headers: { Origin: origin } });
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /^ploq_session=; .*Max-Age=0$/);
    assert.equal((await call("/api/me", { cookie })).status, 401);
});

test("sign-up and device links refuse requests that do not come from the site", async () => {
    // Without this, a page elsewhere could sign a visitor into the attacker's account.
    const noOrigin = await call("/api/signup", { method: "POST", body: { name: "Eve" } });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.data.error, "forbidden");
    assert.equal((await call("/api/signup", { method: "POST", headers: { Origin: "https://evil.example" }, body: { name: "Eve" } })).status, 403);

    const link = await call("/api/device-link", { method: "POST", token: state.admin.token });
    const code = link.data.url.split("/").pop();
    const bare = await call(`/api/device/${code}`, { method: "POST" });
    assert.equal(bare.status, 403);
    assert.equal(bare.setCookie, null);
    assert.equal((await call(`/api/device/${code}`, { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
    // The refused attempts did not use up the code.
    assert.equal((await call(`/api/device/${code}`, { method: "POST", headers: SITE })).status, 200);
});

test("the server's owner has no score limit, and /api/me has no plan", async () => {
    const h = { Authorization: `Bearer ${state.admin.token}` };
    const PK = Buffer.concat([Buffer.from("PK"), Buffer.from("tiny score")]);
    const before = (await call("/api/projects", { headers: h })).data.projects.length;
    for (let i = 0; i < 7; i++) {
        const r = await fetch(`${base}/api/projects/upload?title=u${i}`, { method: "POST", headers: h, body: PK });
        assert.equal(r.status, 200);
    }
    assert.equal((await call("/api/projects", { headers: h })).data.projects.length, before + 7);
    const me = await call("/api/me", { headers: h });
    assert.equal(me.data.mode, "self-host");
    assert.deepEqual(me.data.authMethods, ["name"]);
    assert.equal(me.data.plan, undefined);
});

test("a score's info names its owner", async () => {
    const s = await call("/api/dev/signin", { method: "POST", body: { name: "Live Lee" } });
    const h = { Authorization: `Bearer ${s.data.token}` };
    const PK = Buffer.concat([Buffer.from("PK"), Buffer.from("tiny score")]);
    const up = await fetch(`${base}/api/projects/upload?title=x`, { method: "POST", headers: h, body: PK });
    const { projectId } = await up.json();
    const one = await call(`/api/projects/${projectId}`, { headers: h });
    assert.deepEqual(Object.keys(one.data).sort(), ["ownerName", "projectId", "role", "title", "updatedAt"]);
    assert.equal(one.data.ownerName, "Live Lee");
});

test("an invited account can own SCORE_LIMIT scores", async () => {
    const h = { Authorization: `Bearer ${state.bob.token}` };
    const PK = Buffer.concat([Buffer.from("PK"), Buffer.from("tiny score")]);
    for (let i = 0; i < 3; i++) {
        assert.equal((await call("/api/projects", { method: "POST", token: state.bob.token, body: { title: `b${i}` } })).status, 200);
    }
    const over = await call("/api/projects", { method: "POST", token: state.bob.token, body: { title: "b3" } });
    assert.equal(over.status, 402);
    assert.equal(over.data.error, "You can own up to 3 scores on this server. Delete one to share another.");
    const up = await fetch(`${base}/api/projects/upload?title=b4`, { method: "POST", headers: h, body: PK });
    assert.equal(up.status, 402);
    // The score it joined through the invite isn't its own and doesn't count.
    const mine = (await call("/api/projects", { headers: h })).data.projects;
    assert.equal(mine.filter((p) => p.role === "owner").length, 3);
});

test("the whole server holds at most SERVER_SCORE_LIMIT scores, the owner's too", async () => {
    // The owner (no per-account limit) fills what's left.
    let made = 0;
    let r;
    while ((r = await call("/api/projects", { method: "POST", token: state.admin.token, body: { title: `a${made}` } })).status === 200) {
        made += 1;
        assert.ok(made <= 20, "the server limit never stopped the owner");
    }
    assert.ok(made > 0);
    assert.equal(r.status, 402);
    assert.equal(r.data.error, "This server is full (20 scores). Ask its owner to make room.");
});
