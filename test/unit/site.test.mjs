import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { safeReturnPath } from "../../src/http.js";
import { siteResponse, isSitePage, SITE_CSP } from "../../src/site.js";

// The browser follows ?return= with its own copy of safeReturnPath (public/js/core.js).
// The two must agree, or the client could become an open redirect.
const CLIENT_FILES = ["app.js", "js/core.js", "js/signin.js", "js/list.js", "js/join.js"];
const read = (file) => readFileSync(new URL(`../../public/${file}`, import.meta.url), "utf8");
const coreJs = read("js/core.js");
const source = coreJs.match(/function safeReturnPath\(value\) \{[\s\S]*?\n\}/);
const clientSafeReturnPath = new Function(`${source[0]}; return safeReturnPath;`)();

const CASES = [
    "https://evil.example", "//evil.example", "/\\evil.example", "\\\\evil.example", "/\\/evil.example",
    "javascript:alert(1)", "", " /x", "/\t/evil.example", "/a\nb", "/\u0000x", "/\u007fx", "evil.example",
    "/", "/j/0123456789abcdef01234567", "/app-signin?state=ab&challenge=cd", "/a\\b", "/%2F%2Fevil.example",
    "/" + "a".repeat(511), "/" + "a".repeat(512), undefined, null, 42,
];
for (const value of CASES) {
    test(`client safeReturnPath matches the server for ${JSON.stringify(value)}`, () => {
        assert.equal(clientSafeReturnPath(value), safeReturnPath(value));
    });
}

test("every page path gets the shell with the strict policy", async () => {
    for (const path of ["/", "/scores", "/signin", "/j/0123456789abcdef01234567", "/open/p_0123456789abcdef01234567",
                        "/app-signin", "/device/0123456789abcdef0123456789abcdef"]) {
        const r = siteResponse(path);
        assert.ok(r, path);
        assert.equal(r.headers.get("content-security-policy"), SITE_CSP);
        assert.equal(r.headers.get("x-frame-options"), "DENY");
        assert.equal(r.headers.get("referrer-policy"), "no-referrer");
        assert.equal(r.headers.get("cache-control"), "no-store");
        assert.match(await r.text(), /<link rel="stylesheet" href="\/app.css">/);
    }
});

test("paths that aren't pages get no shell", () => {
    for (const path of ["/api/me", "/room/abc", "/signin/", "/j/xyz", "/device/123", "/scores/123", "/health", "/app.js",
                        "/account", "/scores/p_0123456789abcdef01234567"]) {
        assert.equal(isSitePage(path), false, path);
        assert.equal(siteResponse(path), null, path);
    }
});

test("a deployment can add pages and choose the preloaded scripts", async () => {
    const site = { pages: [/^\/extra$/], scripts: ["core", "other"] };
    assert.equal(siteResponse("/extra"), null);
    const html = await siteResponse("/extra", site).text();
    assert.ok(html.includes('<link rel="modulepreload" href="/js/other.js">'));
    assert.ok(!html.includes("/js/list.js"));
});

test("the client never inserts HTML", () => {
    for (const file of CLIENT_FILES) {
        assert.doesNotMatch(read(file), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
    }
});

test("the shell loads the client as a module, and every module it imports exists and is preloaded", async () => {
    const html = await siteResponse("/").text();
    assert.ok(html.includes('<script type="module" src="/app.js"></script>'));
    const imports = [...read("app.js").matchAll(/^import .*?"\.\/(js\/[a-z]+\.js)";$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), CLIENT_FILES.filter((f) => f !== "app.js").sort());
    for (const file of imports) {
        assert.ok(html.includes(`<link rel="modulepreload" href="/${file}">`), `${file} is preloaded`);
    }
});
