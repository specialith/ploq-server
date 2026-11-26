import test from "node:test";
import assert from "node:assert/strict";
import { safeReturnPath, cookieValue } from "../../src/http.js";

for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", "/\t/evil.example", "/a\nb"])
    test(`safeReturnPath rejects ${JSON.stringify(bad)}`, () => assert.equal(safeReturnPath(bad), "/scores"));
test("safeReturnPath keeps site paths", () => assert.equal(safeReturnPath("/j/abc?x=1"), "/j/abc?x=1"));
test("safeReturnPath refuses non-strings", () => assert.equal(safeReturnPath(undefined), "/scores"));
test("safeReturnPath refuses over 512 chars", () => {
    assert.equal(safeReturnPath("/" + "a".repeat(511)).length, 512);
    assert.equal(safeReturnPath("/" + "a".repeat(512)), "/scores");
});

test("cookieValue finds one cookie among several", () => {
    const req = new Request("http://x/", { headers: { Cookie: "a=1; ploq_session=tok-1_2; b=3" } });
    assert.equal(cookieValue(req, "ploq_session"), "tok-1_2");
    assert.equal(cookieValue(req, "missing"), null);
});
