// What a cursor or selection message may carry on to the other people in a room.
//
// The apps replay a cursor's path with its timing and draw selection boxes where they are told
// to, so values no app would send are stopped here, for every app version: a path point timed
// far ahead (apps would keep everything queued behind it in memory), boxes far outside any page,
// and keys the apps don't use.

const MAX_COORD = 1e6;         // page units; a page is a few thousand across
const MAX_PAGE = 100000;
const MAX_PATH_POINTS = 64;    // the app sends about 16 points per half-second batch...
const MAX_PATH_MS = 2000;      // ...each timed from the start of that batch
const MAX_OUTLINES = 300;      // as many boxes as the app sends, and draws
const MAX_COLOR = 16;

const coord = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
const size = (v) => coord(v) && v >= 0;
const pageIndex = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_PAGE;

//! [x, y, ms since the batch started, ...]: whole triples, on a page, times in order.
function pathOk(path) {
    if (!Array.isArray(path) || path.length % 3 !== 0 || path.length > MAX_PATH_POINTS * 3) {
        return false;
    }
    let last = 0;
    for (let i = 0; i < path.length; i += 3) {
        const at = path[i + 2];
        if (!coord(path[i]) || !coord(path[i + 1]) || typeof at !== "number" || !(at >= last) || at > MAX_PATH_MS) {
            return false;
        }
        last = at;
    }
    return true;
}

//! [page, x, y, width, height]
const outlineOk = (o) => Array.isArray(o) && o.length === 5 && pageIndex(o[0]) && coord(o[1]) && coord(o[2]) && size(o[3]) && size(o[4]);

//! The message to pass on (without `from` and `name`, which the room sets), or null to drop it.
export function cleanPresence(msg) {
    const color = typeof msg.color === "string" && msg.color.length <= MAX_COLOR ? { color: msg.color } : {};
    if (msg.type === "cursor") {
        if (msg.hidden === true) {
            return { type: "cursor", hidden: true };
        }
        if (!pageIndex(msg.page) || !coord(msg.x) || !coord(msg.y)) {
            return null;
        }
        // Without a usable path the apps show the cursor where it ended (as for apps that send none).
        return { type: "cursor", page: msg.page, x: msg.x, y: msg.y, ...color, ...(pathOk(msg.path) ? { path: msg.path } : {}) };
    }
    if (msg.type === "selection") {
        if (!Array.isArray(msg.outlines)) {
            return null;
        }
        const outlines = [];
        for (const o of msg.outlines) {
            if (outlines.length >= MAX_OUTLINES) {
                break;
            }
            if (outlineOk(o)) {
                outlines.push(o);
            }
        }
        return { type: "selection", ...color, outlines };
    }
    return null;
}
