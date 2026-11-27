// The invite page (/j/<code>) and Open in Ploq (/open/<id>).

import { el, api, getMe, signInUrl, render, title, message, failPage, route, signedIn, WENT_WRONG, DOWNLOAD_URL } from "./core.js";

const PROJECT_ID = /^p_[0-9a-f]{24}$/;
const INVALID_INVITE = "This invite link isn't valid. It may have expired. Ask whoever sent it for a new one.";
const backToScores = () => el("p", {}, el("a", { class: "text-link", href: "/scores" }, "Back to your scores"));

// --- Invite page (/j/<code>) ---------------------------------------------------------
// Works signed out: it says who invited you and to what, then sends you to sign in
// and back here. Joining adds you to the score and goes on to open it in Ploq.

route(/^\/j\/([0-9a-f]{24})$/, async (code) => {
    const [invite, me] = await Promise.all([api(`/api/invites/${code}`), getMe()]);
    if (!invite.ok) {
        if (invite.status === 404) {
            render("Invite link", title("Invite link"), el("p", { class: "copy" }, INVALID_INVITE), backToScores());
        } else {
            failPage(invite.data.error);
        }
        return;
    }
    const scoreTitle = invite.data.title || "Untitled score";
    const msg = message();
    let action;
    if (me.ok) {
        action = el("button", { class: "button", type: "button", onclick: async () => {
            action.disabled = true;
            msg.show("");
            const r = await api(`/api/invites/${code}/accept`, { method: "POST" });
            if (r.ok && typeof r.data.projectId === "string" && PROJECT_ID.test(r.data.projectId)) {
                location.assign(`/open/${r.data.projectId}`);
                return;
            }
            action.disabled = false;
            msg.show(r.ok ? WENT_WRONG : r.status === 404 ? INVALID_INVITE : r.data.error, true);
        } }, "Join and open in Ploq");
    } else if (me.status === 401) {
        action = el("a", { class: "button", href: signInUrl(`/j/${code}`) }, "Sign in to join");
    } else {
        failPage(me.data.error);
        return;
    }
    render(scoreTitle,
        el("div", { class: "score-head" },
            el("p", { class: "copy" }, `${invite.data.inviter || "Someone"} invited you to edit`),
            title(scoreTitle, "long")),
        el("div", { class: "actions" }, action),
        msg);
});

// --- Open in Ploq (/open/<id>) ---------------------------------------------------------
// A web page can't tell whether Ploq is installed: it tries the ploq:// link, then
// offers the download and a second try. Each try needs a fresh code (single use).

route(/^\/open\/(p_[0-9a-f]{24})$/, async (id) => {
    const me = await signedIn();
    if (!me) {
        return;
    }
    // Ploq is a desktop app (Windows, macOS, Linux): on a phone or tablet say so; on any computer try
    // the ploq:// link (if Ploq isn't installed, the page below offers the download and a second try).
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
        const project = await api(`/api/projects/${id}`);
        if (!project.ok) {
            render("Open in Ploq", title("Can't open this score", "long"), el("p", { class: "copy" }, project.data.error), backToScores());
            return;
        }
        render("Open in Ploq",
            title(project.data.title || "Untitled score", "long"),
            el("p", { class: "copy" }, "Ploq is a desktop app for Windows, macOS and Linux. Open this score on your computer."),
            backToScores());
        return;
    }

    const first = await launch(id);
    if (first) {
        render("Open in Ploq", title("Can't open this score", "long"), el("p", { class: "copy" }, first), backToScores());
        return;
    }
    const msg = message();
    const retry = el("button", { class: "button outline", type: "button", onclick: async () => {
        retry.disabled = true;
        msg.show("");
        const error = await launch(id);
        retry.disabled = false;
        msg.show(error || "", Boolean(error));
    } }, "Installed? Open the score");
    const later = el("div", { class: "later", hidden: true },
        el("h2", { class: "subtitle" }, "Don't have Ploq yet?"),
        el("div", { class: "actions" }, el("a", { class: "button", href: DOWNLOAD_URL }, "Download Ploq"), retry),
        msg);
    render("Open in Ploq", title("Opening Ploq…", "long"), later);
    setTimeout(() => { later.hidden = false; }, 2500);
});

//! Asks for a one-time code and hands the ploq:// link to the browser. Returns an error sentence, or "".
async function launch(id) {
    const r = await api(`/api/projects/${id}/open`, { method: "POST" });
    const shape = new RegExp(`^ploq://open/${id}\\?code=[0-9a-f]{32}$`);
    if (!r.ok || typeof r.data.url !== "string" || !shape.test(r.data.url)) {
        return r.ok ? WENT_WRONG : r.data.error;
    }
    location.href = r.data.url;
    return "";
}
