// Shared by every page: the helpers (el, api, getMe, render, ...) and the router.
//
// The server answers every page path with the same shell (src/site.js); start()
// picks the page from location.pathname and builds it into <main id="main">.
// Data from the server or the URL only ever reaches the page as text (el()
// appends strings as text nodes); nothing is inserted as HTML.
//
// Adding a page: route(/^\/path\/(captures)$/, async (...captures) => { ... render(...) })
// in a page module that public/app.js imports. The shell's page paths are listed
// in src/site.js too.

export const OFFLINE = "Can't reach the server. Check your connection and try again.";
export const WENT_WRONG = "Something went wrong. Try again.";
//! What POST /api/projects/<id>/invites must answer with (the server's PUBLIC_ORIGIN + /j/<code>).
export const INVITE_URL = /^https?:\/\/[^\s/]+\/j\/[0-9a-f]{24}$/;
export const DOWNLOAD_URL = "https://ploq.app/download";

//! An element. props: "class", "on<event>" (a function), anything else is an
//! attribute (true = present, false/null/undefined = left out). Children are
//! nodes or strings; strings become text, never HTML.
export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null || value === false) {
            continue;
        }
        if (key === "class") {
            node.className = value;
        } else if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2), value);
        } else {
            node.setAttribute(key, value === true ? "" : String(value));
        }
    }
    for (const child of children.flat()) {
        if (child !== undefined && child !== null && child !== false) {
            node.append(child); // strings are appended as text
        }
    }
    return node;
}

//! Calls this site's API. Returns {ok, status, data}; data.error is always a
//! sentence to show when !ok. body: JSON.
export async function api(path, { method = "GET", body } = {}) {
    const init = { method, credentials: "same-origin", headers: {} };
    if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
    }
    let res;
    try {
        res = await fetch(path, init);
    } catch {
        return { ok: false, status: 0, data: { error: OFFLINE } };
    }
    let data = {};
    try {
        data = (await res.json()) || {};
    } catch { /* not JSON */ }
    if (!res.ok && typeof data.error !== "string") {
        data.error = WENT_WRONG;
    }
    return { ok: res.ok, status: res.status, data };
}

// Who is signed in, asked once per page load. Signed out is a 401.
let meRequest = null;
export const getMe = () => (meRequest ||= api("/api/me"));

//! Same rule as safeReturnPath in src/http.js (keep the two identical): only
//! paths on this site; anything that could leave it becomes "/scores".
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

export const here = () => location.pathname + location.search;
export const signInUrl = (returnTo) => `/signin?return=${encodeURIComponent(returnTo)}`;

//! Signed in, or sent to sign-in (and back here after). Returns /api/me's data, or null.
export async function signedIn() {
    const me = await getMe();
    if (me.status === 401) {
        location.replace(signInUrl(here()));
        return null;
    }
    if (!me.ok) {
        failPage(me.data.error);
        return null;
    }
    return me.data;
}

//! Shows a page: the tab title and the contents of <main>.
export function render(title, ...nodes) {
    document.title = title ? `${title} · Ploq` : "Ploq";
    document.getElementById("main").replaceChildren(...nodes.flat().filter(Boolean));
    window.scrollTo(0, 0);
}

export const title = (text, cls = "") => el("h1", { class: `page-title ${cls}`.trim() }, text);

//! A line for status and errors, announced to screen readers.
export function message() {
    const node = el("p", { class: "message", role: "status", "aria-live": "polite" });
    node.show = (text, isError = false) => {
        node.textContent = text || "";
        node.classList.toggle("error", Boolean(text) && isError);
    };
    return node;
}

//! A short note that floats at the bottom of the screen and goes away by itself (4 s, the bar
//! shows how long is left; hovering pauses it), so confirmations never push the page around.
//! Use message() for errors, which should stay until the next try.
let toastRegion = null;
export function toast(text) {
    if (!toastRegion) {
        toastRegion = el("div", { class: "toasts", role: "status", "aria-live": "polite" });
        document.body.append(toastRegion);
    }
    const bar = el("div", { class: "toast-bar", "aria-hidden": "true" });
    const close = () => {
        if (!node.isConnected || node.classList.contains("leaving")) {
            return;
        }
        node.classList.add("leaving");
        setTimeout(() => node.remove(), 160);
    };
    const node = el("div", { class: "toast" },
        el("p", { class: "toast-text" }, text),
        el("button", { class: "toast-close", type: "button", "aria-label": "Dismiss", onclick: close }, "×"),
        bar);
    bar.addEventListener("animationend", close);
    toastRegion.replaceChildren(node); // one at a time: a new note replaces the last
    return close;
}

//! Copies `text`, and says so; if the browser won't, shows it to copy by hand.
export async function copyText(text, done = "Copied.") {
    try {
        await navigator.clipboard.writeText(text);
        toast(done);
    } catch {
        window.prompt("Copy this:", text);
    }
}

//! A labelled input: returns the wrapper; .input is the <input>.
let fieldCount = 0;
export function field(label, attrs = {}) {
    const id = `f${++fieldCount}`;
    const input = el("input", { class: "input", id, ...attrs });
    const wrap = el("div", { class: "field" }, el("label", { class: "label", for: id }, label), input);
    wrap.input = input;
    return wrap;
}

//! A form that never navigates (the policy blocks form submissions anyway);
//! Enter or the button calls onSubmit. The submit button is disabled meanwhile.
export function form(onSubmit, ...children) {
    const node = el("form", { class: "form", novalidate: true }, ...children);
    node.addEventListener("submit", async (e) => {
        e.preventDefault();
        const button = node.querySelector("button[type=submit]");
        if (button && button.disabled) {
            return;
        }
        if (button) {
            button.disabled = true;
        }
        try {
            await onSubmit();
        } finally {
            if (button && button.isConnected) {
                button.disabled = false;
            }
        }
    });
    return node;
}

export const submit = (text, cls = "button") => el("button", { class: cls, type: "submit" }, text);

//! A confirm button for something that can't be undone. For `ms` after it appears it can't be
//! pressed: red fills it from the left like a loading bar, then it turns solid red and works. So
//! a double click, or a click that lands a moment too soon, can't confirm by accident.
//! onConfirm(button) runs on a press once it's ready; disable/enable the button there as needed.
export function armedButton(text, onConfirm, { ms = 2000, cls = "button" } = {}) {
    const button = el("button", { class: `${cls} armed-confirm arming`, type: "button", "aria-disabled": "true" },
        el("span", { class: "arm-fill", "aria-hidden": "true" }), el("span", { class: "arm-label" }, text));
    button.style.setProperty("--arm", `${ms}ms`); // CSSOM, which the style policy allows
    let ready = false;
    const arm = () => {
        if (ready) {
            return;
        }
        ready = true;
        button.classList.replace("arming", "armed");
        button.removeAttribute("aria-disabled");
    };
    button.querySelector(".arm-fill").addEventListener("animationend", arm);
    setTimeout(arm, ms + 150); // in case the animation doesn't run (hidden tab, no animations)
    button.addEventListener("click", () => {
        if (ready && !button.disabled) {
            onConfirm(button);
        }
    });
    return button;
}

//! The page for an unexpected failure.
export function failPage(error) {
    render("Something went wrong",
        title("Something went wrong"),
        el("p", { class: "copy" }, error || WENT_WRONG),
        el("p", {}, el("button", { class: "text-link", type: "button", onclick: () => location.reload() }, "Try again")));
}

//! The page for a path the router doesn't know.
export function notFoundPage() {
    render("Not found",
        title("Not found"),
        el("p", {}, el("a", { class: "text-link", href: "/scores" }, "Back to your scores")));
}

// --- Router -------------------------------------------------------------------

const routes = [];
export const route = (pattern, page) => routes.push([pattern, page]);

//! The parts of the shell that depend on who is asking: Sign out (signed in).
async function decorateShell() {
    const me = await getMe();
    const nav = document.getElementById("nav");
    if (me.ok && nav && !nav.firstChild) {
        const out = el("button", { class: "text-link", type: "button", onclick: async () => {
            out.disabled = true;
            await api("/api/signout", { method: "POST" });
            location.replace("/signin");
        } }, "Sign out");
        nav.append(out);
    }
}

export async function start() {
    decorateShell().catch((e) => console.error(e));
    const path = location.pathname;
    for (const [pattern, page] of routes) {
        const m = path.match(pattern);
        if (m) {
            try {
                await page(...m.slice(1));
            } catch (e) {
                console.error(e);
                failPage();
            }
            return;
        }
    }
    notFoundPage();
}
