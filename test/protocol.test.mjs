// Protocol tests for the sync server.
//
//   npm test
//       starts the local Node relay on a spare port and tests it.
//   COLLAB_TEST_URL=ws://127.0.0.1:8788 npm test
//       tests an already-running server instead (e.g. `wrangler dev` or the
//       deployed Cloudflare server, wss://collab.ploq.app) — including the
//       late-join snapshot tests, which only the Cloudflare server supports.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const external = process.env.COLLAB_TEST_URL && process.env.COLLAB_TEST_URL.replace(/^http/, "ws");
let server = null;
let base = external;
if (!external) {
    const port = 18787;
    server = spawn(process.execPath, [fileURLToPath(new URL("../relay/server.mjs", import.meta.url)), String(port)],
                   { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise(resolve => server.stdout.on("data", d => String(d).includes("listening") && resolve()));
    base = `ws://127.0.0.1:${port}`;
}
let failed = false;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); failed ||= !ok; };

// --- Accounts (Cloudflare server, Phase 7): sign up Alice/Bob/Carol, Alice
// creates a project and an invite link, Bob and Carol accept it. Rooms are
// then only open to members, with their sign-in token. The local relay has
// no accounts: a random room name and no token.
const http = external ? base.replace(/^ws/, "http") : null;
const tokens = {};
const userIds = {};
let room = `test-${randomBytes(12).toString("hex")}`;
let roomPath = `/${room}`;
let inviteUrl = null;
let mainProjectId = null;

const api = async (path, { method = "GET", token, body, headers = {} } = {}) => {
    const r = await fetch(`${http}${path}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
};

if (external) {
    for (const name of ["Alice", "Bob", "Carol", "Mallory"]) {
        const r = await api("/api/dev/signin", { method: "POST", body: { name } });
        tokens[name] = r.data?.token;
        userIds[name] = r.data?.userId;
        if (!tokens[name]) {
            console.log(`  sign-up for ${name} returned HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
        }
    }
    check(typeof tokens.Alice === "string" && tokens.Alice.length >= 40, "sign up returns a long sign-in token");
    const me = await api("/api/me", { token: tokens.Alice });
    check(me.status === 200 && me.data.name === "Alice", "the token signs Alice in (/api/me)");
    check((await api("/api/me", { token: "not-a-real-token" })).status === 401, "a wrong token is refused");

    const proj = await api("/api/projects", { method: "POST", token: tokens.Alice, body: { title: "Amazing <Grace>" } });
    check(proj.status === 200 && /^[0-9a-f]{32}$/.test(proj.data.room), "Alice creates a project with a random room");
    room = proj.data.room;
    mainProjectId = proj.data.projectId;
    roomPath = `/room/${room}`;

    const inv = await api(`/api/projects/${proj.data.projectId}/invites`, { method: "POST", token: tokens.Alice });
    inviteUrl = inv.data.url;
    check(inv.status === 200 && /\/j\/[0-9a-f]{24}$/.test(inviteUrl), `Alice gets an invite link (${inviteUrl})`);
    const notMine = await api(`/api/projects/${proj.data.projectId}/invites`, { method: "POST", token: tokens.Mallory });
    check(notMine.status === 403, "a non-member can't make invite links");

    check(inviteUrl.startsWith(`${http}/j/`) && /^[0-9a-f]{24}$/.test(inviteUrl.slice(`${http}/j/`.length)), "invite links point at the website (the server's PUBLIC_ORIGIN)");
    const page = await fetch(inviteUrl.replace(/^https?:\/\/[^/]+/, http));
    const html = await page.text();
    const csp = page.headers.get("content-security-policy") || "";
    check(page.status === 200 && html.includes('<script type="module" src="/app.js"></script>') && /script-src 'self';/.test(csp)
          && !/unsafe-inline/.test(csp), "the invite page loads, with a strict script policy (own script only, no unsafe-inline)");
    // The page itself is drawn by the client (no browser here): the shell preloads the
    // module with the invite page, and that module asks for the invite and offers to join.
    // (js/join.js on a plain server; js/score.js on ploq.app, whose site adds the score page.)
    const moduleFile = ["js/join.js", "js/score.js"].find((f) => html.includes(`<link rel="modulepreload" href="/${f}">`));
    const pageModule = moduleFile ? await fetch(`${http}/${moduleFile}`).then((r) => (r.ok ? r.text() : "")) : "";
    check(pageModule.includes("route(/^\\/j\\/([0-9a-f]{24})$/") && pageModule.includes("/api/invites/${code}")
          && pageModule.includes("invited you to edit") && pageModule.includes("Join and open in Ploq")
          && pageModule.includes("Sign in to join"), "the invite page's script asks for the invite and offers to join");
    const code0 = inviteUrl.split("/").pop();
    const info = await api(`/api/invites/${code0}`);
    check(info.status === 200 && info.data.title === "Amazing <Grace>" && info.data.inviter === "Alice",
          "the invite page gets the score title and who invited you");
    check((await api("/api/invites/000000000000000000000000")).status === 404, "an unknown invite link shows 'not valid'");

    const code = inviteUrl.split("/").pop();
    for (const name of ["Bob", "Carol"]) {
        const acc = await api(`/api/invites/${code}/accept`, { method: "POST", token: tokens[name] });
        check(acc.status === 200 && acc.data.room === room, `${name} accepts the invite and gets the room`);
    }
    const viaBrowser = await api(`/api/invites/${code}/accept`, { method: "POST", token: tokens.Mallory,
                                                                  headers: { Origin: "https://evil.example" } });
    check(viaBrowser.status === 403, "API calls from another website (Origin header) are refused");
    const sameSite = await api("/api/me", { token: tokens.Alice, headers: { Origin: http } });
    check(sameSite.status === 200, "...but the site's own pages can call it");

    // --- Security fixes (issues.md) ---
    const editorInvite = await api(`/api/projects/${proj.data.projectId}/invites`, { method: "POST", token: tokens.Bob });
    check(editorInvite.status === 403, "#5 only the owner can make invite links (an editor can't)");
    const hdr = await fetch(`${http}/api/me`, { headers: { Authorization: `Bearer ${tokens.Alice}` } });
    check(hdr.headers.get("x-content-type-options") === "nosniff" && /max-age=\d+/.test(hdr.headers.get("strict-transport-security") || ""),
          "#9 API responses carry nosniff and HSTS headers");
    const pageHdr = await fetch(`${http}/`);
    check(pageHdr.headers.get("x-content-type-options") === "nosniff", "#9 the website does too");
    const sneaky = await api("/api/dev/signin", { method: "POST", body: { name: "Ev‮an​" } });
    check(sneaky.data.name === "Evan", "#10 invisible direction / zero-width characters are stripped from names");
    const invInfo = await api(`/api/invites/${inviteUrl.split("/").pop()}`);
    check(/^[0-9a-f]{6}$/.test(invInfo.data.inviterId || ""), "#10 the invite page gets a short account id for the inviter");
    const outTok = sneaky.data.token;
    check((await api("/api/signout", { method: "POST", token: outTok })).status === 200
          && (await api("/api/me", { token: outTok })).status === 401, "#5 signing out really ends that sign-in");

    // --- Website flow: upload a score, list it, open it in the app ---
    const mscz = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("uploaded score bytes ".repeat(2000))]);
    const up = await fetch(`${http}/api/projects/upload?title=${encodeURIComponent("Ode to Joy")}`, {
        method: "POST", headers: { Authorization: `Bearer ${tokens.Alice}`, "content-type": "application/octet-stream" }, body: mscz });
    const upData = await up.json();
    check(up.status === 200 && /^p_/.test(upData.projectId), "the website uploads a .mscz and creates a project");
    const notZip = await fetch(`${http}/api/projects/upload?title=x`, {
        method: "POST", headers: { Authorization: `Bearer ${tokens.Alice}` }, body: "not a score" });
    check(notZip.status === 400, "uploading something that isn't a .mscz is refused");
    const mine = await api("/api/projects", { token: tokens.Alice });
    check(mine.status === 200 && mine.data.projects.some(p => p.projectId === upData.projectId && p.role === "owner"),
          "Alice's score list includes it");
    const openLink = await api(`/api/projects/${upData.projectId}/open`, { method: "POST", token: tokens.Alice });
    const om = /^ploq:\/\/open\/(p_[0-9a-f]{24})\?code=([0-9a-f]{32})$/.exec(openLink.data.url || "");
    check(openLink.status === 200 && om && om[1] === upData.projectId, "\"Open in Ploq\" gives a one-time app link");
    const notMember = await api(`/api/projects/${upData.projectId}/open`, { method: "POST", token: tokens.Mallory });
    check(notMember.status === 403, "...only for people in that score");
    const preview = await api(`/api/login/${om[2]}`);
    check(preview.status === 200 && preview.data.name === "Alice" && preview.data.title === "Ode to Joy"
          && /^[0-9a-f]{6}$/.test(preview.data.accountId), "#2 the app can preview a link (who, which score) before using it");
    const redeem = await api(`/api/login/${om[2]}`, { method: "POST" });
    check(redeem.status === 200 && redeem.data.name === "Alice" && redeem.data.project.room === upData.room,
          "the app trades the code for Alice's sign-in and the score's room");
    const appMe = await api("/api/me", { token: redeem.data.token });
    check(appMe.status === 200 && appMe.data.name === "Alice" && redeem.data.token !== tokens.Alice,
          "the app gets its own token for the same account");
    check((await api(`/api/login/${om[2]}`, { method: "POST" })).status === 404, "the code only works once");
    // The uploaded score is the room's score: joining downloads it.
    const up1 = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base}/room/${upData.room}`, { headers: { Authorization: `Bearer ${redeem.data.token}` } });
        const inbox = [];
        ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            inbox.push(msg);
            if (msg.type === "welcome") { ws.send(JSON.stringify({ type: "sync", sinceSeq: -1 })); }
            if (msg.type === "snapshot") { ws.close(); resolve(msg); }
        });
        ws.on("open", () => ws.send(JSON.stringify({ type: "join", color: "#e6194b" })));
        ws.on("unexpected-response", (req, res) => reject(new Error(`room refused the app: HTTP ${res.statusCode}`)));
        ws.on("error", reject);
        setTimeout(() => reject(new Error("no snapshot for the uploaded score")), 15000);
    });
    check(up1.data === mscz.toString("base64") && up1.title === "Ode to Joy", "opening it in the app downloads the uploaded score");
    // #6: two redemptions racing for one code: exactly one wins.
    const raceLink = await api(`/api/projects/${upData.projectId}/open`, { method: "POST", token: tokens.Alice });
    const raceCode = /code=([0-9a-f]{32})/.exec(raceLink.data.url)[1];
    const race = await Promise.all([1, 2, 3].map(() => api(`/api/login/${raceCode}`, { method: "POST" })));
    check(race.filter(r => r.status === 200).length === 1, "#6 racing redemptions of one code: exactly one succeeds");
    // #5: the owner deletes the score.
    const del = await api(`/api/projects/${upData.projectId}`, { method: "DELETE", token: tokens.Alice });
    const gone = await api(`/api/projects/${upData.projectId}/open`, { method: "POST", token: tokens.Alice });
    const listed = await api("/api/projects", { token: tokens.Alice });
    check(del.status === 200 && gone.status === 403 && !listed.data.projects.some(p => p.projectId === upData.projectId),
          "#5 the owner can delete a score");
}

const connect = (token) => new WebSocket(`${base}${roomPath}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
const refused = (ws) => new Promise((resolve) => {
    ws.on("open", () => { ws.close(); resolve(false); });
    ws.on("error", () => resolve(true));
    ws.on("unexpected-response", (req, res) => resolve(res.statusCode));
});

if (external) {
    check(await refused(connect(null)) === 401, "a room refuses people who aren't signed in");
    check(await refused(connect(tokens.Mallory)) === 403, "a room refuses signed-in people who weren't invited");
}

const open = (name) => new Promise((resolve, reject) => {
    const ws = connect(tokens[name]);
    const inbox = [];
    ws.on("message", m => inbox.push(JSON.parse(m.toString())));
    ws.on("open", () => { ws.send(JSON.stringify({ type: "join", name, color: "#123456" })); resolve({ ws, inbox }); });
    ws.on("error", reject);
});
const waitFor = async (inbox, pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const hit = inbox.find(pred);
        if (hit) { return hit; }
        await new Promise(r => setTimeout(r, 5));
    }
    throw new Error("timed out waiting for message");
};

try {
    const a = await open("Alice");
    const b = await open("Bob");
    await waitFor(a.inbox, m => m.type === "welcome");
    const bWelcome = await waitFor(b.inbox, m => m.type === "welcome");
    if (external) {
        const aliceMembers = await api(`/api/projects/${mainProjectId}/members`, { token: tokens.Alice });
        const aliceShort = aliceMembers.data.members.find(x => x.name === "Alice")?.accountId;
        const alicePeer = bWelcome.peers.find(x => x.name === "Alice");
        check(/^[0-9a-f]{6}$/.test(aliceShort || "") && alicePeer?.accountId === aliceShort,
              "welcome peers carry accountId matching the members list");
        const bobPresence = await waitFor(a.inbox, m => m.type === "presence" && m.peers.some(x => x.name === "Bob"));
        check(bobPresence.peers.every(x => /^[0-9a-f]{6}$/.test(x.accountId || "")), "presence peers carry accountId");
    }

    const t0 = Date.now();
    a.ws.send(JSON.stringify({ type: "edit", editId: 1, tickFrom: 0, tickTo: 1920, staffFrom: 0, staffTo: 1, xml: "<StaffList/>" }));
    const got = await waitFor(b.inbox, m => m.type === "edit");
    const ms = Date.now() - t0;
    const ack = await waitFor(a.inbox, m => m.type === "ack");

    check(got.seq === 1, "B receives edit with seq 1");
    check(got.name === "Alice" && got.xml === "<StaffList/>", "edit carries sender name and XML unchanged");
    check(ack.seq === 1 && ack.editId === 1, "A gets ack for its edit");
    check(!a.inbox.some(m => m.type === "edit"), "A does not get its own edit echoed back");
    check(ms < 100, `relay round trip ${ms} ms (< 100 ms)`);

    // --- No measure locks (since 2026-11-25) ---
    // An old app's "lock" is ignored, and Bob can edit the measure Alice has
    // selected: the server's order decides who wins it.
    const m3 = { tickFrom: 3840, tickTo: 5760, staffFrom: 0, staffTo: 1 };
    a.ws.send(JSON.stringify({ type: "lock", regions: [m3] }));
    await new Promise(r => setTimeout(r, 100));
    check(!b.inbox.some(m => ["lock", "locks", "lock-denied"].includes(m.type)) && !a.inbox.some(m => m.type === "error"),
          "a lock message is ignored: no broadcast, no reply, no error");

    b.ws.send(JSON.stringify({ type: "edit", editId: 7, baseSeq: 1, ...m3, xml: "<StaffList/>" }));
    const bobsEdit = await waitFor(a.inbox, m => m.type === "edit" && m.editId === 7);
    const bobsAck = await waitFor(b.inbox, m => m.type === "ack" && m.editId === 7);
    check(bobsEdit.seq === 2 && bobsAck.seq === 2, "Bob's edit in the measure Alice selected goes through as edit #2");
    check(bobsEdit.baseSeq === 1, "baseSeq is passed through unchanged");

    a.ws.send(JSON.stringify({ type: "edit", editId: 8, baseSeq: 1, ...m3, xml: "<StaffList/>" }));
    const alicesEdit = await waitFor(b.inbox, m => m.type === "edit" && m.editId === 8);
    const alicesAck = await waitFor(a.inbox, m => m.type === "ack" && m.editId === 8);
    check(alicesEdit.seq === 3 && alicesAck.seq === 3 && alicesEdit.baseSeq === 1,
          "two clients editing the same measure are both accepted, seq increasing (2 then 3)");
    await new Promise(r => setTimeout(r, 50));
    check(!a.inbox.concat(b.inbox).some(m => ["locks", "lock-denied", "edit-rejected"].includes(m.type)),
          "no lock messages or rejections");

    // A browser page (which always sends Origin) must be refused.
    const browserRefused = await new Promise((resolve) => {
        const evil = new WebSocket(`${base}${roomPath}`, { origin: "https://evil.example",
                                                          headers: tokens.Bob ? { Authorization: `Bearer ${tokens.Bob}` } : {} });
        evil.on("open", () => { evil.close(); resolve(false); });
        evil.on("error", () => resolve(true));
        evil.on("unexpected-response", () => resolve(true));
    });
    check(browserRefused, "connection from a web page (Origin header) is refused");
    check(!b.inbox.some(m => m.type === "presence" && m.peers.length > 2), "refused client never joined the room");

    b.ws.close();
    await waitFor(a.inbox, m => m.type === "presence" && m.peers.length === 1);
    check(true, "Alice is told Bob left");

    if (!external) {
        // QA 2026-11-24: one "null" message crashed the relay for every room, and
        // it forwarded any message type, so a client could forge server messages.
        const c = await open("Carol");
        await waitFor(c.inbox, m => m.type === "welcome");
        for (const junk of ["null", "[]", "42", "\"hi\""]) {
            a.ws.send(junk);
        }
        a.ws.send(JSON.stringify({ type: "welcome", clientId: 999, seq: 5, peers: [] }));
        a.ws.send(JSON.stringify({ type: "locks", holders: [] }));
        a.ws.send(JSON.stringify({ type: "presence", peers: [] }));
        a.ws.send(JSON.stringify({ type: "cursor", page: 0, x: 1, y: 2 }));
        await waitFor(c.inbox, m => m.type === "cursor");
        check(true, "the relay survives 'null' / '[]' / '42' / '\"hi\"' messages");
        check(!c.inbox.some(m => m.from !== undefined && m.type !== "cursor"),
              "the relay drops forged server messages (welcome, locks, presence); cursors still pass");
        c.inbox.length = 0;
        a.ws.send(JSON.stringify({ type: "cursor", page: 0, x: 9, y: 9, path: [0, 0, 1e15, 9, 9, 0], extra: "x" }));
        const held = await waitFor(c.inbox, m => m.type === "cursor" && m.x === 9);
        check(held.path === undefined && held.extra === undefined,
              "the relay leaves out a cursor path timed far ahead (apps would queue it for good) and keys the apps don't use");
        c.ws.close();
    }

    if (external) {
        // --- Late join (Cloudflare server only) ---
        // Alice uploads the score as it stands after edit 2, then edits once more.
        const seqNow = a.inbox.filter(m => m.type === "ack").length + 1; // edits so far: Alice's 1 + Bob's #2
        // Not a zip ("PK" header) -> refused; a 3 MB "zip" -> stored in R2.
        a.ws.send(JSON.stringify({ type: "snapshot-put", baseSeq: seqNow, data: Buffer.from("hello").toString("base64") }));
        await waitFor(a.inbox, m => m.type === "snapshot-refused", 10000);
        check(true, "a snapshot that isn't an .mscz (zip) file is refused");
        const score = Buffer.from("PK fake mscz " + "x".repeat(3_200_000)).toString("base64");
        a.ws.send(JSON.stringify({ type: "snapshot-put", baseSeq: seqNow, title: "Amazing Grace", data: score }));
        const saved = await waitFor(a.inbox, m => m.type === "snapshot-saved", 15000);
        check(saved.baseSeq === seqNow, `score snapshot stored in R2 (${(score.length / 1e6).toFixed(1)} MB)`);
        a.ws.send(JSON.stringify({ type: "edit", editId: 9, tickFrom: 0, tickTo: 1920, staffFrom: 1, staffTo: 2, xml: "<after/>" }));
        await waitFor(a.inbox, m => m.type === "ack" && m.editId === 9);

        // Carol joins late and asks to catch up from nothing.
        const c = await open("Carol");
        const welcome = await waitFor(c.inbox, m => m.type === "welcome");
        check(welcome.snapshot.exists && welcome.snapshot.baseSeq === seqNow, "late joiner is told a snapshot exists");
        c.ws.send(JSON.stringify({ type: "sync", sinceSeq: -1 }));
        const snap = await waitFor(c.inbox, m => m.type === "snapshot", 15000);
        check(snap.data === score && snap.title === "Amazing Grace", "late joiner receives the exact score and its title");
        const synced = await waitFor(c.inbox, m => m.type === "synced", 10000);
        const replay = c.inbox.filter(m => m.type === "edit");
        check(replay.length === 1 && replay[0].xml === "<after/>" && synced.seq === replay[0].seq,
              "...then only the edits made after that snapshot, in order");

        // Reconnecting with an up-to-date seq gets nothing to replay.
        c.inbox.length = 0;
        c.ws.send(JSON.stringify({ type: "sync", sinceSeq: synced.seq }));
        await waitFor(c.inbox, m => m.type === "synced");
        check(!c.inbox.some(m => m.type === "snapshot" || m.type === "edit"), "an up-to-date client gets nothing to replay");
        c.ws.close();

        // Structural change (instruments/measures/signatures): the whole score
        // becomes the room's score as the next numbered step; others reload it.
        const b2 = await open("Bob");
        await waitFor(b2.inbox, m => m.type === "welcome");
        const lastSeq = synced.seq;
        const restructured = Buffer.from("PK score with a new instrument").toString("base64");
        a.ws.send(JSON.stringify({ type: "structure", editId: 42, title: "Amazing Grace", data: restructured }));
        const reload = await waitFor(b2.inbox, m => m.type === "snapshot" && m.reload, 15000);
        check(reload.data === restructured && reload.baseSeq === lastSeq + 1 && reload.name === "Alice",
              "a structural change reaches others as a whole-score reload, in edit order");
        const ack42 = await waitFor(a.inbox, m => m.type === "ack" && m.editId === 42, 15000);
        check(ack42.seq === lastSeq + 1, "...and the sender gets its edit number");
        const d = await open("Carol");
        await waitFor(d.inbox, m => m.type === "welcome");
        d.ws.send(JSON.stringify({ type: "sync", sinceSeq: -1 }));
        const dSnap = await waitFor(d.inbox, m => m.type === "snapshot", 15000);
        check(dSnap.data === restructured, "a late joiner afterwards gets the restructured score");
        d.ws.close();
        b2.ws.close();

        // An edit too big to keep in the log is refused before it gets a number: numbered, broadcast and
        // acknowledged but not kept, a client catching up later skipped it without knowing.
        const g = await open("Bob");
        await waitFor(g.inbox, m => m.type === "welcome");
        const seqBefore = ack42.seq;
        const edit = (editId, xml) => JSON.stringify({ type: "edit", editId, tickFrom: 0, tickTo: 1920, staffFrom: 0, staffTo: 1, xml });
        a.ws.send(edit(50, "x".repeat(1_900_000)));
        const big = await waitFor(a.inbox, m => (m.type === "edit-rejected" || m.type === "ack") && m.editId === 50, 15000);
        check(big.type === "edit-rejected" && big.reason === "too big", "an edit too big to store is refused ('too big'), not numbered");
        a.ws.send(edit(51, "<small/>"));
        const ack51 = await waitFor(a.inbox, m => m.type === "ack" && m.editId === 51, 15000);
        await waitFor(g.inbox, m => m.type === "edit" && m.editId === 51);
        check(ack51.seq === seqBefore + 1 && !g.inbox.some(m => m.type === "edit" && m.editId === 50),
              "...nobody gets it, and the next edit takes the next number");
        const h = await open("Carol");
        await waitFor(h.inbox, m => m.type === "welcome");
        h.ws.send(JSON.stringify({ type: "sync", sinceSeq: seqBefore }));
        const caught = await waitFor(h.inbox, m => m.type === "synced", 15000);
        const replayed = h.inbox.filter(m => m.type === "edit").map(m => m.seq);
        check(caught.seq === seqBefore + 1 && JSON.stringify(replayed) === JSON.stringify([seqBefore + 1]),
              "a client catching up gets every numbered edit, with no gaps");
        h.ws.close();
        g.ws.close();

        // #3: members can't forge server messages to each other.
        const fa = await open("Alice");
        const fb = await open("Bob");
        await waitFor(fa.inbox, m => m.type === "welcome");
        await waitFor(fb.inbox, m => m.type === "welcome");
        fb.ws.send(JSON.stringify({ type: "snapshot", reload: true, baseSeq: 1, title: "x", data: "UEsDBA==" }));
        fb.ws.send(JSON.stringify({ type: "welcome", clientId: 999 }));
        fb.ws.send(JSON.stringify({ type: "locks", holders: [] }));
        fb.ws.send(JSON.stringify({ type: "cursor", page: 0, x: 1, y: 2 }));
        await waitFor(fa.inbox, m => m.type === "cursor" && m.name === "Bob");
        check(!fa.inbox.some(m => (m.type === "snapshot" && m.reload) || (m.type === "welcome" && m.clientId === 999)),
              "#3 forged snapshot/welcome messages from a member are dropped (cursors still pass)");

        // #5: the owner removes Carol - she's disconnected now and can't come back.
        const fc = await open("Carol");
        await waitFor(fc.inbox, m => m.type === "welcome");
        const closed = new Promise(resolve => fc.ws.on("close", (code) => resolve(code)));
        const members = await api(`/api/projects/${mainProjectId}/members`, { token: tokens.Alice });
        check(members.status === 200 && members.data.members.some(x => x.name === "Carol"), "#5 the owner can see who's in the score");
        const kick = await api(`/api/projects/${mainProjectId}/members/${userIds.Carol}`, { method: "DELETE", token: tokens.Alice });
        const closeCode = await Promise.race([closed, new Promise(r => setTimeout(() => r("still open"), 10000))]);
        check(kick.status === 200 && closeCode === 4003, "#5 removing a member disconnects them from the live score");
        check(await refused(connect(tokens.Carol)) === 403, "#5 ...and they can't reconnect");
        check((await api(`/api/invites/${inviteUrl.split("/").pop()}`)).status === 404,
              "#5 removing a member also turns off the invite links (no way back in through an old link)");

        // A connection that floods is limited: messages pass in a burst of 120, then 20 a second.
        fa.inbox.length = 0;
        fb.inbox.length = 0;
        for (let i = 0; i < 400; i++) {
            fb.ws.send(JSON.stringify({ type: "cursor", page: 0, x: i, y: 0 }));
        }
        // ...and an edit in the middle of the flood is refused out loud ("slow down"), never dropped silently.
        fb.ws.send(JSON.stringify({ type: "edit", editId: 777, tickFrom: 0, tickTo: 1920, staffFrom: 0, staffTo: 1, xml: "<x/>" }));
        await new Promise(r => setTimeout(r, 1500));
        const passed = fa.inbox.filter(m => m.type === "cursor").length;
        check(passed >= 100 && passed < 300, `a flood of 400 cursor messages is cut to ${passed} (rate limit)`);
        const slow = await waitFor(fb.inbox, m => (m.type === "edit-rejected" || m.type === "ack") && m.editId === 777);
        check(slow.type === "edit-rejected" && slow.reason === "slow down", "an edit sent while flooding gets edit-rejected 'slow down'");
        await new Promise(r => setTimeout(r, 7000)); // let the bucket refill
        fa.inbox.length = 0;
        fb.ws.send(JSON.stringify({ type: "cursor", page: 0, x: 0, y: 0, pad: "x".repeat(70 * 1024) }));
        fb.ws.send(JSON.stringify({ type: "cursor", page: 0, x: 7, y: 7 }));
        await waitFor(fa.inbox, m => m.type === "cursor" && m.x === 7);
        check(!fa.inbox.some(m => m.type === "cursor" && m.pad), "an oversized cursor message (70 KB) isn't passed on; normal ones are");
        fa.inbox.length = 0;
        fb.ws.send(JSON.stringify({ type: "cursor", page: 0, x: 9, y: 9, path: [0, 0, 1e15, 9, 9, 0], extra: "x" }));
        const held = await waitFor(fa.inbox, m => m.type === "cursor" && m.x === 9);
        check(held.path === undefined && held.extra === undefined && held.name === "Bob",
              "a cursor path timed far ahead (apps would queue it for good) and keys the apps don't use aren't passed on");
        const bobKick = await api(`/api/projects/${mainProjectId}/members/${userIds.Alice}`, { method: "DELETE", token: tokens.Bob });
        check(bobKick.status === 403, "#5 an editor can't remove people");

        // #5: the owner turns off invite links.
        const off = await api(`/api/projects/${mainProjectId}/invites`, { method: "DELETE", token: tokens.Alice });
        check(off.status === 200 && (await api(`/api/invites/${inviteUrl.split("/").pop()}`)).status === 404,
              "#5 the owner can turn off invite links");
        fa.ws.close();
        fb.ws.close();

        // The old Phase 6 way in (any long room name, no account) is gone.
        const legacy = new WebSocket(`${base}/${randomBytes(16).toString("hex")}`);
        check(await refused(legacy) === 404, "rooms can no longer be opened without an account and invite");
    }
    a.ws.close();
} catch (e) {
    check(false, e.message);
}
server?.kill();
process.exit(failed ? 1 : 0);
