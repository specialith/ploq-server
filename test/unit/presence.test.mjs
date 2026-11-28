import test from "node:test";
import assert from "node:assert/strict";
import { cleanPresence } from "../../src/presence.js";

test("a cursor batch as the app sends it passes unchanged", () => {
    const msg = { type: "cursor", page: 2, x: 120.5, y: 88.1, color: "#e06c00", path: [100, 80, 0, 110.2, 84, 33, 120.5, 88.1, 67] };
    assert.deepEqual(cleanPresence(msg), msg);
});

test("an old app's cursor (no path) passes", () => {
    assert.deepEqual(cleanPresence({ type: "cursor", page: 0, x: 1, y: 2 }), { type: "cursor", page: 0, x: 1, y: 2 });
});

test("a hidden cursor carries nothing else", () => {
    assert.deepEqual(cleanPresence({ type: "cursor", hidden: true, page: 5, path: [0, 0, 1e15] }), { type: "cursor", hidden: true });
});

test("keys the apps don't use are not passed on", () => {
    assert.deepEqual(cleanPresence({ type: "cursor", page: 0, x: 1, y: 2, from: 7, name: "Mallory", seq: 3, pad: "x" }),
                     { type: "cursor", page: 0, x: 1, y: 2 });
});

// The apps replay a path with its timing and wait for each point's time: a point timed far
// ahead would hold everything queued behind it in memory for good.
for (const [why, path] of [
    ["a point timed far ahead", [0, 0, 1e15, 5, 5, 0]],
    ["a point timed over 2 seconds into the batch", [0, 0, 0, 5, 5, 2001]],
    ["times that go backwards", [0, 0, 300, 5, 5, 100]],
    ["a negative time", [0, 0, -1, 5, 5, 0]],
    ["a length that isn't x, y, time triples", [0, 0, 0, 5, 5]],
    ["more than 64 points", Array.from({ length: 65 * 3 }, (_, i) => (i % 3 === 2 ? Math.floor(i / 3) : 1))],
    ["a point far off any page", [0, 2e6, 0]],
    ["something that isn't a number", [0, "0", 0]],
    ["something that isn't a list", { 0: 1 }],
]) {
    test(`a cursor path with ${why} is left out; the cursor still arrives where it ended`, () => {
        assert.deepEqual(cleanPresence({ type: "cursor", page: 0, x: 9, y: 9, path }), { type: "cursor", page: 0, x: 9, y: 9 });
    });
}

test("a path of exactly 64 points timed up to 2 seconds passes", () => {
    const path = Array.from({ length: 64 * 3 }, (_, i) => (i % 3 === 2 ? Math.floor(i / 3) : 1));
    path[path.length - 1] = 2000;
    assert.deepEqual(cleanPresence({ type: "cursor", page: 0, x: 1, y: 1, path }).path, path);
});

for (const [why, msg] of [
    ["no page", { type: "cursor", x: 1, y: 2 }],
    ["a negative page", { type: "cursor", page: -1, x: 1, y: 2 }],
    ["a fractional page", { type: "cursor", page: 0.5, x: 1, y: 2 }],
    ["a spot far off any page", { type: "cursor", page: 0, x: 1e7, y: 2 }],
    ["an infinite spot (1e400 in JSON)", { type: "cursor", page: 0, x: 1, y: Infinity }],
    ["a spot that isn't a number", { type: "cursor", page: 0, x: "1", y: 2 }],
]) {
    test(`a cursor with ${why} is dropped`, () => assert.equal(cleanPresence(msg), null));
}

test("a selection as the app sends it passes unchanged", () => {
    const msg = { type: "selection", color: "#e06c00", outlines: [[0, 10, 20, 300.5, 40], [1, 0, 0, 5, 5]] };
    assert.deepEqual(cleanPresence(msg), msg);
});

test("an empty selection (nothing selected) passes", () => {
    assert.deepEqual(cleanPresence({ type: "selection", outlines: [] }), { type: "selection", outlines: [] });
});

test("selection boxes no app would send are left out; the rest pass", () => {
    const good = [0, 10, 20, 30, 40];
    const msg = { type: "selection", outlines: [
        good,
        [0, -100000000, -100000000, 300000000, 300000000], // far bigger than any page
        [0, 10, 20, -30, 40],                              // negative width
        [0, 10, 20, 30, Infinity],
        [-1, 10, 20, 30, 40],                              // no such page
        [0, 10, 20, 30],                                   // not page, x, y, width, height
        [0, "10", 20, 30, 40],
        "box",
    ] };
    assert.deepEqual(cleanPresence(msg), { type: "selection", outlines: [good] });
});

test("at most 300 selection boxes are passed on", () => {
    const outlines = Array.from({ length: 301 }, (_, i) => [0, i, 0, 5, 5]);
    const out = cleanPresence({ type: "selection", outlines });
    assert.equal(out.outlines.length, 300);
    assert.deepEqual(out.outlines[299], [0, 299, 0, 5, 5]);
});

test("a selection whose boxes aren't a list is dropped", () => {
    assert.equal(cleanPresence({ type: "selection", outlines: "all" }), null);
    assert.equal(cleanPresence({ type: "selection" }), null);
});

test("a colour longer than 16 characters, or not text, is left out", () => {
    assert.deepEqual(cleanPresence({ type: "cursor", page: 0, x: 1, y: 2, color: "#".repeat(17) }), { type: "cursor", page: 0, x: 1, y: 2 });
    assert.deepEqual(cleanPresence({ type: "selection", outlines: [], color: 255 }), { type: "selection", outlines: [] });
});

test("any other message type is dropped", () => {
    assert.equal(cleanPresence({ type: "welcome", clientId: 1 }), null);
});
