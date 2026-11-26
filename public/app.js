// The website: dependency-free ES modules.
//
//   js/core.js     helpers (el, api, getMe, render, ...) and the router
//   js/signin.js   /signin, /app-signin (signing the desktop app in), /device/<code>
//   js/list.js     / and /scores: your scores (Open in Ploq, Copy link, Delete)
//   js/join.js     /j/<code> (an invite link), /open/<id> (Open in Ploq)
//
// Each page module registers its routes with route(); start() then picks the
// page for location.pathname. The shell's page paths are listed in src/site.js.

import { start } from "./js/core.js";
import "./js/signin.js";
import "./js/list.js";
import "./js/join.js";

start();
