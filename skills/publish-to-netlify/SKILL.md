---
name: publish-to-netlify
description: "Put a site or web app online at a public link on the person's own Netlify account, and update the same link later. Use when the person asks to deploy, host or publish a site or app for people outside, or when it needs functions, a database or a backend; a simple page or report uses publish_page instead."
---

# Publish to Netlify

You build the site in your working folder and publish it to the person's own Netlify account. They get a link that
stays the same when you change the site. The account, its limits and its bill are theirs.

## Pick the right home

| The person wants | Use |
|---|---|
| A page, report or dashboard to look at or share (static files, up to 5 MB and 200 files) | `show_html`, and `publish_page` for a link. Nothing to set up. |
| A site or app for people outside, a bigger site, or a link to keep changing over time | Netlify, with `deploy.mjs` (below). |
| Forms that save, sign-up lists, an API, a database, a backend | Netlify with its command line (see "Functions, a database, a backend"). |

Publish only when the person asks. If they only asked you to build something, show it first and offer the link.

## Before anything goes out

- A published link is public: anyone who has it can open it, and there is no sign-in for visitors. Say so the first
  time you publish for a person.
- Never publish secrets, keys, private files, memory or notes, anything from another person's chat, or a team's
  private data. A page's code is readable by every visitor, so nothing secret goes in it either.
- If the content looks personal or internal (names with contact details, customer lists, money, health, staff or
  unreleased plans), ask before publishing, and say exactly what would become public.
- Publish only the output folder, never your whole working folder.

## The token, once

Call `request_credential` with label `Netlify personal access token`, delivery `file`, and a reason such as:
"To publish your site on your Netlify account. Create one at
https://app.netlify.com/user/applications#personal-access-tokens (Applications → Personal access tokens → New access
token) and paste it here. A free account works." End your turn; you resume when they save it.

You get the path of a private file, not the token. Later, in any conversation, ask again with the same label: the
saved token comes back at once with no card. If Netlify answers 401, the token was revoked (a Netlify password reset
does that): ask again with `replace: true`.

Only ever pass that file's path. Never print the token, read it into your reply, put it in a command's text, write it
into the project, or commit it.

## Build light

- Prefer plain HTML, CSS and JavaScript with no build step, or a small build. Load libraries from a CDN at pinned
  versions rather than installing them.
- The output folder needs an `index.html` at its top.
- A build must finish inside one shell call (10 minutes at most; pass the longer `timeout`). Run it in the
  foreground, and leave nothing running afterwards: no dev server, no watcher, no preview.
- If the person runs you on a small cloud machine (about 2 GB of memory), a framework app with a large dependency
  install can run it out of memory or time. Say so before starting one, and offer the lighter way first.

### A heavy build, on your cloud computer

Light sites build where you run; that is the default. When the build is heavy (a framework app with a large install,
or one that would strain a 2 GB machine or the 10-minute limit) and `select_computer` shows a cloud computer you can
use:

1. Tell the person first: a cloud computer uses their plan's monthly hours while it is on.
2. Switch with `select_computer` (`surface: "cloud"`); if it answers pending, end your turn and carry on when you
   are resumed. Send the source as one archive with `copy_to_computer`, and build there with `exec`
   (`background: true`, then `exec_status`).
3. Pack only the built output into one file under `/tmp` (`tar czf /tmp/site.tgz -C dist .`), bring it back with
   `copy_from_computer`, and unpack it in your working folder.
4. Deploy from your working folder, as below. Start nothing else on the cloud computer; it goes to sleep by itself
   once idle.

The Netlify token never goes to the cloud computer: never copy its file there, type it there, or run a deploy there.
The deploy always runs where the token file was delivered.

## Deploy

`deploy.mjs` sits next to this guide, in the folder named by this skill's `root`. It needs Node 18 or later and
nothing installed, and works through the proxy your commands already use. Run it from the project folder:

```sh
node "<root>/deploy.mjs" --dir <output folder> --token-file <the secret file's path>
```

- The first run creates a site on the person's account and writes `.netlify-site.json` in the project folder (the
  site's id, name and addresses; never the token). Keep that file: with it, every later run updates the same link.
  If it is gone, a new run makes a second site with a new link.
- `--name my-site` asks for that address (`my-site.netlify.app`) on the first run; names are shared by all of
  Netlify, so it may be taken. Without it Netlify picks a name.
- `--project <folder>` when the project folder is not the current one. `--draft` publishes a preview at its own
  address and leaves the live site as it is.
- It never uploads dotfiles and dot folders (`.env`, `.git`, `.openmausbot-secrets`, the site record),
  `node_modules`, env files, keys or certificates, or links to files elsewhere, and it stops if any file contains the
  token. The answer lists what it left out under `skipped`.
- Only changed files are uploaded. Netlify allows 3 deploys a minute and 100 a day through its API: batch your
  changes rather than deploying after each one.

It prints one line of JSON:

- `"ok": true`, `"state": "ready"`, `"live": true`: Netlify processed the deploy and the link answered. Reply with the
  link (`url`), what you published in one or two lines, and that the link is public.
- `"access": "private"`: the site is deployed, but the link asks for a Netlify login. New Netlify accounts keep every
  site visible to the account's own team only. This is not a failure. Give the link, say that right now only people
  signed in to their Netlify team can open it, and ask whether to open it to anyone with the link. Run
  `node "<root>/deploy.mjs" --make-public --token-file <the secret file's path>` only after they say yes; it changes
  that one site and checks the link again.
- `live` false with `"liveStatus": 200`: the link answers, but not as a web page (`contentType` is not `text/html`),
  so a browser would show the page's source. Say so; don't call it published.
- `live` false otherwise: say the deploy was sent but the link did not answer yet, and give the link; don't wait in a
  loop.
- `"ok": false`: tell the person plainly what Netlify answered (`error`) and what you will try; don't retry the same
  thing more than once.

## Functions, a database, a backend

`deploy.mjs` publishes static files only. For anything that runs on Netlify's side, read the current steps at
https://docs.netlify.com first (they change), then use Netlify's own command line. Run `deploy.mjs` once first so the
site and `.netlify-site.json` exist, then:

```sh
NETLIFY_AUTH_TOKEN="$(cat <the secret file's path>)" NETLIFY_SITE_ID=<siteId from .netlify-site.json> \
  npx --yes netlify-cli deploy --prod --dir <output folder> --json
```

The token is read from the file inside the command, never typed. The command line is a large download: on a small
machine say so first, and give the call the long timeout. It runs the project's build before deploying; add
`--no-build` when there is nothing to build.

- **Functions** (`netlify/functions/`): small request handlers. Good for a form, an API route, a webhook.
- **Database**: Netlify's managed Postgres. It needs a credit-based Netlify plan and uses the person's credits while
  it is active: say so before adding one.
- **Server** (`netlify/server/index.mjs`, one per project): a long-running Node backend. It is in Early Access, so
  how it works may change. It needs Node 24 and netlify-cli 27.17.0 or later, stops after 5 minutes without requests
  and takes a moment to start again, and runs one copy on Free plans. Never promise that it is always on, and don't
  use it for a full-stack framework (those deploy as functions).
- Keys the site needs at run time belong in Netlify's own environment settings, which the person sets in Netlify.
  Never put them in the files you publish.

Visitors cannot sign in on what you build here in this version: don't build a login, and don't collect passwords.
