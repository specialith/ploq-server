// Sign-in pages: /signin (by name), /app-signin (hands the desktop app a sign-in) and
// /device/<code> (a link from "Sign in on another computer").

import { el, api, getMe, safeReturnPath, here, signInUrl, render, title, message, field, form, submit, failPage,
    route, WENT_WRONG } from "./core.js";

const NEEDS_INVITE = "You need an invite link to join this server.";

// --- Sign in (/signin?return=) ----------------------------------------------------
// By name. The first account on a server is its owner and needs the setup code chosen when the
// server was deployed (the field appears when the server asks for it); after that, a new account
// needs an invite link (coming from an invite page, its code goes along).

route(/^\/signin$/, async () => {
    const params = new URLSearchParams(location.search);
    const returnTo = safeReturnPath(params.get("return"));
    const me = await getMe();
    if (me.ok) {
        location.replace(returnTo); // already signed in
        return;
    }
    if (me.status !== 401) {
        failPage(me.data.error);
        return;
    }
    const invite = (returnTo.match(/^\/j\/([0-9a-f]{24})$/) || [])[1];
    const nameField = field("Your name", { type: "text", name: "name", autocomplete: "name", maxlength: "40", required: true });
    const setupField = field("Setup code", { type: "password", name: "setup-code", autocomplete: "off", maxlength: "200" });
    setupField.hidden = true;
    const msg = message();
    render("Sign in",
        title("Sign in to Ploq"),
        el("div", { class: "column" },
            form(async () => {
                const name = nameField.input.value.trim();
                if (!name) {
                    msg.show("Type a name.", true);
                    nameField.input.focus();
                    return;
                }
                msg.show("");
                const setupCode = setupField.hidden ? "" : setupField.input.value.trim();
                const r = await api("/api/signup", { method: "POST",
                    body: { name, ...(invite ? { invite } : {}), ...(setupCode ? { setupCode } : {}) } });
                if (!r.ok) {
                    if (r.status === 403 && r.data.setup === "needed") {
                        // A new server: its first account (the owner) needs the setup code.
                        setupField.hidden = false;
                        msg.show(r.data.error, true);
                        setupField.input.focus();
                        return;
                    }
                    msg.show(r.status === 403 && !r.data.setup ? NEEDS_INVITE : r.data.error, true);
                    return;
                }
                location.replace(returnTo);
            }, nameField, el("p", { class: "note" }, "People you share scores with see this name."), setupField, submit("Continue"), msg),
            el("p", { class: "note" },
                "Already have an account? On a computer where you're signed in, open Your scores and choose Sign in on another computer.")));
    nameField.input.focus();
});

// --- App sign-in (/app-signin?state=&challenge=) ---------------------------------
// Ploq (the desktop app) opens this page; the ploq://signin link hands it a
// single-use code that only works with the app's own verifier.

route(/^\/app-signin$/, async () => {
    const params = new URLSearchParams(location.search);
    const state = params.get("state") || "";
    const challenge = params.get("challenge") || "";
    if (!/^[0-9a-f]{32}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
        render("Sign in", title("Sign in to Ploq"),
            el("p", { class: "copy" }, "That sign-in link isn't valid. Start again from Ploq."));
        return;
    }
    const me = await getMe();
    if (me.status === 401) {
        location.replace(signInUrl(here()));
        return;
    }
    if (!me.ok) {
        failPage(me.data.error);
        return;
    }

    const msg = message();
    const button = el("button", { class: "button", type: "button", onclick: async () => {
        button.disabled = true;
        msg.show("");
        const r = await api("/api/app-signin", { method: "POST", body: { state, challenge } });
        if (!r.ok || typeof r.data.url !== "string" || !/^ploq:\/\/signin\?state=[0-9a-f]{32}&code=[0-9a-f]{32}$/.test(r.data.url)) {
            button.disabled = false;
            msg.show(r.ok ? WENT_WRONG : r.data.error, true);
            return;
        }
        location.href = r.data.url;
        render("Sign in", title("You can go back to Ploq now.", "long"));
    } }, "Sign in");
    const switchAccount = el("button", { class: "text-link", type: "button", onclick: async () => {
        switchAccount.disabled = true;
        await api("/api/signout", { method: "POST" });
        location.replace(signInUrl(here()));
    } }, "Use a different account");

    render("Sign in",
        title(`Sign in to Ploq on this computer as ${me.data.name}?`, "long"),
        el("div", { class: "actions" }, button, switchAccount),
        msg);
});

// --- Device link (/device/<code>) -------------------------------------------------
// A one-time link from "Sign in on another computer". Redeeming it uses it up,
// so it waits for a click (link previews and prefetching don't spend it). The
// page first says whose account the link is for, so a link someone else made
// can't quietly sign the reader in to their account.

const accountIdOf = (userId) => String(userId || "").replace(/^u_/, "").slice(0, 6);

route(/^\/device\/([0-9a-f]{32})$/, async (code) => {
    const [link, me] = await Promise.all([api(`/api/device/${code}`), getMe()]);
    if (!link.ok) {
        render("Sign in", title("Sign in on this computer"),
            el("p", { class: "copy" }, link.data.error));
        return;
    }
    const name = link.data.name;
    const signedInAs = me.ok ? me.data : null;
    if (signedInAs && accountIdOf(signedInAs.userId) === link.data.accountId) {
        render("Signed in", title("You're already signed in"),
            el("p", { class: "copy" }, "This browser is already signed in as ", el("strong", {}, name), "."),
            el("p", {}, el("a", { class: "text-link", href: "/scores" }, "Your scores")));
        return;
    }

    const msg = message();
    const button = el("button", { class: "button", type: "button", onclick: async () => {
        button.disabled = true;
        msg.show("");
        const r = await api(`/api/device/${code}`, { method: "POST" });
        if (!r.ok) {
            button.disabled = false;
            msg.show(r.data.error, true);
            return;
        }
        location.replace("/scores");
    } }, "Sign in");
    const copy = signedInAs
        ? el("p", { class: "copy" }, "You're signed in as ", el("strong", {}, signedInAs.name),
            ". This link signs this browser in to ", el("strong", {}, name), "'s account instead. It works once.")
        : el("p", { class: "copy" }, "This link signs this browser in to ", el("strong", {}, name),
            "'s Ploq account. It works once.");
    render("Sign in",
        title(`Sign in as ${name}?`, "long"),
        copy,
        el("p", { class: "note" }, "Only continue if this is your account."),
        button,
        msg);
});
