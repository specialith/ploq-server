// Your scores (/ and /scores): every score you're in, with Open in Ploq, and for scores you own,
// Copy link (an invite link) and Delete. Sharing a new score happens in the desktop app (Share).

import { el, api, render, title, message, failPage, route, signedIn, copyText, toast, armedButton, INVITE_URL,
    DOWNLOAD_URL, WENT_WRONG } from "./core.js";

route(/^\/(?:scores)?$/, async () => {
    const me = await signedIn();
    if (!me) {
        return;
    }
    const list = await api("/api/projects");
    if (!list.ok) {
        failPage(list.data.error);
        return;
    }
    const projects = Array.isArray(list.data.projects) ? list.data.projects : [];
    const body = projects.length
        ? el("ul", { class: "list scores" }, projects.map(scoreRow))
        : el("div", { class: "column" },
            el("p", { class: "copy" }, "No scores yet. Open a score in Ploq and press Share, then send the link."),
            el("p", {}, el("a", { class: "text-link", href: DOWNLOAD_URL }, "Download Ploq")));
    render("Your scores", title("Your scores"), body, anotherComputer());
});

//! One score: its title, whose it is, and what you can do with it.
function scoreRow(p) {
    const mine = p.role === "owner";
    const row = el("li", { class: "score" });
    const actions = el("div", { class: "score-actions" });
    const open = () => el("a", { class: "text-link score-action", href: `/open/${p.projectId}` }, "Open in Ploq");

    const showActions = () => {
        actions.replaceChildren(
            mine && copyLinkButton(p.projectId),
            mine && el("button", { class: "text-link score-action", type: "button", onclick: confirmDelete }, "Delete"),
            open());
    };
    // Asked in place: the row keeps its size, so nothing below it moves. The confirm button fills for
    // 2 seconds before it works, so a double click on Delete can't delete.
    const confirmDelete = () => {
        const yes = armedButton("Delete for everyone", async () => {
            yes.disabled = true;
            const r = await api(`/api/projects/${p.projectId}`, { method: "DELETE" });
            if (!r.ok) {
                yes.disabled = false;
                toast(r.data.error || WENT_WRONG);
                return;
            }
            row.remove();
            toast(`Deleted ${p.title || "the score"}.`);
        }, { cls: "button small" });
        actions.replaceChildren(yes, el("button", { class: "text-link score-action", type: "button", onclick: showActions }, "Cancel"));
        yes.focus();
    };
    showActions();

    row.append(
        el("div", { class: "score-main" },
            el("span", { class: "score-title" }, p.title || "Untitled score"),
            el("p", { class: "score-meta" }, mine ? "Yours" : "Shared with you")),
        actions);
    return row;
}

//! Owner's "Copy link": makes an invite link (one per visit) and copies it.
function copyLinkButton(projectId) {
    let link = null;
    const button = el("button", { class: "text-link score-action", type: "button", onclick: async () => {
        button.disabled = true;
        try {
            if (!link) {
                const r = await api(`/api/projects/${projectId}/invites`, { method: "POST" });
                if (!r.ok || typeof r.data.url !== "string" || !INVITE_URL.test(r.data.url)) {
                    toast(r.ok ? WENT_WRONG : r.data.error);
                    return;
                }
                link = r.data.url;
            }
            await copyText(link, "Link copied. Anyone with it can join and edit for 14 days.");
        } finally {
            button.disabled = false;
        }
    } }, "Copy link");
    return button;
}

//! "Sign in on another computer": a one-time link (15 minutes) that signs another browser in to
//! this account. Accounts here have no password, so this is how you sign in somewhere else.
function anotherComputer() {
    const msg = message();
    const button = el("button", { class: "text-link", type: "button", onclick: async () => {
        button.disabled = true;
        msg.show("");
        const r = await api("/api/device-link", { method: "POST" });
        button.disabled = false;
        if (!r.ok || typeof r.data.url !== "string" || !/^https?:\/\/[^\s/]+\/device\/[0-9a-f]{32}$/.test(r.data.url)) {
            msg.show(r.ok ? WENT_WRONG : r.data.error, true);
            return;
        }
        await copyText(r.data.url, "Link copied. Open it on the other computer within 15 minutes. It works once.");
    } }, "Sign in on another computer");
    return el("div", { class: "later" }, button, msg);
}
