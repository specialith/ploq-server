# ploq-server

The sync server for **[Ploq](https://ploq.app)**, real-time collaboration for MuseScore. Everyone
in a score sees each other's edits, cursors and selections live. The order the server receives
edits in decides who wins a measure.

It runs on Cloudflare: a Worker, one Durable Object per shared score, D1 for accounts, and R2 for
the scores. ploq.app runs one for everyone; this repository lets you run your own, free, on your
own Cloudflare account.

It's deliberately small: rooms, sync and storage, sign-in by name, invite links, and a few web
pages (sign in, your scores, the invite page, Open in Ploq). No plans, no billing, no email.

## Run your own server

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and a GitHub account.

### The easy way: one button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/specialith/ploq-server)

1. Click the button and sign in to Cloudflare and GitHub when asked.
2. Keep the suggested names (or change them) and click **Create and deploy**. Cloudflare copies
   this repository to your GitHub, creates the database and the storage bucket, sets up the
   database, and puts the server online.
   - If it asks you to enable **R2** (Cloudflare's file storage, where the scores are kept), do
     that in the dashboard under **R2 Object Storage** and try again. R2 has a free tier, but
     Cloudflare asks for a payment method before turning it on.
3. When it's done, Cloudflare shows your server's address, something like
   `https://ploq-server.your-name.workers.dev`. Open it and check that the page loads.
4. **Sign in first.** The first person to sign in on a new server becomes its owner. Everyone
   after that needs an invite link to one of the owner's scores.
5. Point Ploq at your server. Everyone who uses your server does this once: open **Command
   Prompt** (or PowerShell), run the line below with your server's address, then restart Ploq.

   ```
   setx COLLAB_SERVER "https://ploq-server.your-name.workers.dev"
   ```

   Ploq uses ploq.app's server when `COLLAB_SERVER` isn't set. To go back to it, run
   `reg delete HKCU\Environment /v COLLAB_SERVER /f` and restart Ploq.

That's it. Updates you push to your copy on GitHub deploy themselves.

### Or from a terminal

```sh
git clone https://github.com/specialith/ploq-server
cd ploq-server
npm install
npx wrangler login
npm run deploy
```

`npm run deploy` creates the database and the storage bucket on the first run, applies the
database migrations, and prints your server's `workers.dev` address. Run it again after updating.
Then follow steps 4 and 5 above.

### Your own domain (optional)

In the Cloudflare dashboard, open the Worker, go to **Settings > Domains & Routes** and add your
domain (it must be on Cloudflare). Then add `"vars": { "PUBLIC_ORIGIN": "https://your.domain" }`
to `wrangler.jsonc` and deploy again, so invite links use it.

### Signing in

People sign in with just a name. The first account on a server is its owner; everyone after
that needs an invite link to one of the owner's scores. To sign in on another computer, open
**Your scores** on one where you're signed in and choose **Sign in on another computer**: it
copies a one-time link that works for 15 minutes.

**https is required for the website.** The session cookie is `Secure`, which browsers keep only
over https (or on `localhost` / `127.0.0.1`). `workers.dev` addresses and Cloudflare custom
domains are https already. The desktop app signs in with its own token and is not affected.

## What's in here

| Path | What it is |
|---|---|
| `src/index.js`, `core.js` | The Worker: HTTP API and routing |
| `src/room.js` | The `Room` Durable Object (one per score: orders edits, tracks who is connected, catches late joiners up) |
| `src/projects.js` | Scores: create, upload, list, invites, members, delete, Open in Ploq |
| `src/auth.js`, `session.js` | Name sign-in, sessions, device links |
| `src/site.js`, `public/` | The website: one page shell for every page path, plus `app.js` and `js/*.js`, `app.css`, fonts and images, served as static assets |
| `migrations/` | D1 schema (accounts, sessions, scores, members, invites, sign-in codes) |
| `relay/server.mjs` | A tiny local relay for app development without Cloudflare (no accounts) |
| `test/` | `unit/` (node:test), `selfhost.test.mjs` (HTTP API), `protocol.test.mjs` (rooms and sync) |

The message protocol is described in the app repository,
[ploq-app](https://github.com/specialith/ploq-app) (`docs/collab/PROTOCOL.md`).

## API

JSON over HTTPS. `*` means signed in: the app sends `Authorization: Bearer <token>`, the website
uses a session cookie.

```
  POST   /api/signup                {name, invite?} -> {userId, name, token}  (sets cookie)
  POST   /api/signout                    *        -> {} (this token stops working)
  POST   /api/device-link                 *        -> {url}  (one-time, 15 min)
  GET    /api/device/<code>                        -> {name, accountId}  (preview, no side effects)
  POST   /api/device/<code>                        -> {name}  (sets cookie; single use)
  GET    /api/me                          *        -> {userId, name, mode, authMethods}
                                                    (signed out: 401 {error, mode, authMethods}, for the sign-in page)
  POST   /api/app-signin                  * {state, challenge} -> {url: ploq://signin?...}  (website -> app sign-in)
  GET    /health                                   -> text (liveness)
  GET    /api/invites/<code>                       -> {title, inviter, inviterId}
  POST   /api/invites/<code>/accept       *        -> {projectId, room, title}
  GET    /api/login/<code>                         -> {name, accountId, title}  (preview, no side effects)
  POST   /api/login/<code>                         -> {token, userId, name, project}  (single use)
  GET    /api/projects                    *        -> {projects}
  POST   /api/projects                    * {title} -> {projectId, room, title}
  POST   /api/projects/upload?title=      * .mscz  -> {projectId, room, title}
  POST   /api/projects/<id>/open          *        -> {url: ploq://open/...}
  POST   /api/projects/<id>/invites       * owner  -> {code, url}
  DELETE /api/projects/<id>/invites       * owner  -> {} (all invite links stop working)
  GET    /api/projects/<id>/members       *        -> {members}
  DELETE /api/projects/<id>/members/<uid> * owner  -> {}
  DELETE /api/projects/<id>               * owner  -> {} (deletes the score for everyone)
  GET    /api/projects/<id>               *        -> {projectId, title, role, ownerName, updatedAt}
  GET    /room/<room>                     * WebSocket (members only)
```

The `/api/dev/*` routes exist only when `DEV_TOOLS=1` and the origin is localhost; never set that
in production.

## Settings

Set them under `vars` in `wrangler.jsonc` (or with `--var` locally). There are no secrets.

| Setting | Values | What it does |
|---|---|---|
| `PUBLIC_ORIGIN` | `https://your.domain` | The server's public address. Invite and device links point here. Default: the address the request came in on. Behind a proxy it must match the address people actually use |
| `DEV_TOOLS` | `1` | Test-only routes; honored only on localhost / 127.0.0.1 |

## Run it locally

```sh
npm install
npm run migrate:local   # local D1 under .wrangler/local
npm run dev             # http://127.0.0.1:8799
```

## Tests

```sh
npm run test:unit       # node:test, no server needed
npm run test:server     # HTTP API: fresh database, starts its own server on :8799
npm run test:worker     # rooms and sync against the Worker: fresh database, its own server on :8799
npm test                # rooms and sync against the local relay (relay/), which it starts itself
```

`test:server` and `test:worker` refuse to run if port 8799 is busy.

## Security notes

- Rooms only admit signed-in members of that score. Members are added through invite links, which
  only the owner can create. Owners can turn off links, remove members, and delete scores.
- Sign-in tokens are random and only their SHA-256 is stored. They expire after 180 days.
- Browser requests are only accepted from the site's own pages. The website runs under a strict
  nonce-based CSP.
- The Room relays only `cursor` and `selection` between clients. All other client messages are
  handled by the server or dropped.
- Rate limits cover sign-up, sign-in codes and device links, and changes.

Found a security problem? Please report it privately through GitHub's
**Security > Report a vulnerability** on this repository rather than in a public issue.

## License

ploq-server is free software: you can redistribute it and/or modify it under the terms of the
[GNU Affero General Public License version 3](LICENSE) (AGPL-3.0). If you run a modified version
as a service, the AGPL requires you to offer its source code to the people who use it.

The license covers the code, not the Ploq name or logo: see [TRADEMARKS.md](TRADEMARKS.md) for
what you can and can't do with them.

Copyright Ploq, LLC (https://ploq.app).

The Ploq desktop app is separate and is free software under the GNU GPL v3:
[ploq-app](https://github.com/specialith/ploq-app). Ploq is based on MuseScore Studio and is not
affiliated with Muse Group.
