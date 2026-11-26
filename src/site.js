// The website: one HTML shell for every page. public/app.js (an ES module; the pages are in
// public/js/) reads location.pathname and builds the page; public/app.css styles it. Styles,
// scripts, fonts and images are static assets (wrangler.jsonc "assets"), so the policy allows
// only this site's own files.
//
// A deployment can add pages and change which page scripts are preloaded:
//   siteResponse(path, { pages: [/^\/more$/], scripts: ["core", "signin", ...] })

import { SECURITY_HEADERS } from "./http.js";

export const SITE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; "
    + "connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

// Page paths the shell answers (app.js has the matching routes).
const PAGES = [
    /^\/$/,                       // your scores
    /^\/scores$/,                 // your scores
    /^\/signin$/,
    /^\/app-signin$/,             // signing the desktop app in through the browser
    /^\/j\/[0-9a-f]{24}$/,        // an invite link
    /^\/open\/p_[0-9a-f]{24}$/,   // "Open in Ploq"
    /^\/device\/[0-9a-f]{32}$/,   // "Sign in on another computer"
];
const SCRIPTS = ["core", "signin", "list", "join"];

export const isSitePage = (path, extraPages = []) => [...PAGES, ...extraPages].some((re) => re.test(path));

const shell = (scripts) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#000000">
<title>Ploq</title>
<link rel="preload" href="/fonts/Inter-Light.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/Inter-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script type="module" src="/app.js"></script>
${scripts.map((s) => `<link rel="modulepreload" href="/js/${s}.js">`).join("\n")}
</head>
<body>
<div class="shell">
<header class="wrap top">
<a class="brand" href="/" aria-label="Ploq home"><img src="/brand/ploq-mark-white.svg" alt="" width="35" height="30"><span>Ploq</span></a>
<nav class="nav" id="nav" aria-label="Account"></nav>
</header>
<main class="wrap page" id="main">
<noscript><h1 class="page-title">Turn on JavaScript</h1><p class="copy">This site needs JavaScript to sign you in and show your scores.</p></noscript>
</main>
</div>
</body>
</html>
`;

//! The shell for a page path (`route` is the URL path), or null if it isn't a page.
export function siteResponse(route, site = {}) {
    if (!isSitePage(route, site.pages || [])) {
        return null;
    }
    return new Response(shell(site.scripts || SCRIPTS), {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
            "content-security-policy": SITE_CSP,
            ...SECURITY_HEADERS,
        },
    });
}
