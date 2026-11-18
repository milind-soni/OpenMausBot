# Published apps

The Published apps page (Tools → Published apps) lists what bots put online: the pages this server published to a
MausBot link, and the sites bots published to the person's own Netlify account, found from the `.netlify-site.json`
records in the bots' own folders (`skills/publish-to-netlify/site-record.md`). A card's Preview, and a published link
in a bot's message, open the app in a sandboxed frame beside the conversation. Delete takes an app down for good.

## The list, who sees what, and Delete

```sh
pnpm exec vitest run server/host/netlify-sites.test.ts server/host/published-apps.test.ts server/routes/published-apps.test.ts
```

- Records are found at most four folders deep, never in hidden folders or `node_modules`, never through a link, never
  over 16 KB, at most 50 a bot; the person's home folder and anything above it is never searched.
- A record belongs to the bot whose folder holds it, whatever bot it names. Its address must be plain https, and its
  Netlify account page must be on `app.netlify.com`.
- On a Team Cloud a person is shown an app only through a conversation they can read in which the bot published it (a
  page's card, or the bot's own message carrying the site's link). An admin sees what shared bots published in shared
  conversations and nobody's private project. An id or address of an app someone is not shown answers 404.
- Delete: a page is unpublished; a Netlify site is deleted with `DELETE /sites/<id>` using the token saved for that
  bot, a 404 from Netlify counts as deleted, and the record is removed. Without a usable token nothing is called and
  the answer offers the site's Netlify page. The token is in no answer and no log line.

A real Team Cloud with four people (two members, an Admin, the Owner) and real turns:

```sh
pnpm exec vitest run server/cloud-team-published-apps.e2e.test.ts
```

A site whose record is in a conversation's own folder (`task-workspaces/<bot>/<thread>`) is that conversation's; one in
a folder the bot's conversations share is listed where the bot's own message carries its link, and nowhere when it
never said it. Another member, an Admin and the Owner get 404 for a member's private project by id. Delete answers
`no_token` with the site's Netlify page until a token is saved; with the team's shared token an Admin deletes the
shared chat's site and a member their own, on the loopback stand-in. A member's own saved token is used only on that
member's own click (`savedNetlifyToken`, in `server/host/netlify-sites.test.ts`).

## The page, the cards and the preview

```sh
pnpm exec vitest run src/components/published-apps src/lib/published-links.test.ts
```

`src/components/published-apps/preview.security.test.ts` holds the frame's sandbox (`allow-scripts allow-same-origin allow-forms allow-popups`, a
card's picture only the first two), that the app's own origin and anything but a plain web address is never framed,
that the preview registers no message listener and passes nothing into the frame, and that the desktop window keeps
its preload out of frames.

## Renderer and server, end to end

```sh
OMB_UI_EVIDENCE_DIR=evidence/published-apps pnpm exec vitest run scripts/testing/published-apps-ui.e2e.test.ts
```

It runs when an agent-browser binary resolves, as in [Chat UI, driven headlessly](chat-ui.md), and is skipped
otherwise; `OMB_UI_E2E=1` forces the verified download. The fixture's server gets `OMB_NETLIFY_API_URL`, the loopback
stand-in (`server/testing/fake-netlify.ts`), which the launcher lets cross only when it is `http://127.0.0.1:PORT/api/v1`.

- The real publish helper deploys two sites from Pepper's folder to the stand-in; one is then made to ask for a login.
- The page shows the empty state first, then both cards: the public site drawn live and small, the other as a tile.
  Its header matches the Automations page's, with the sidebar still there.
- Preview opens Pepper's chat with the site beside it. The site's own script tries the bridge, the parent's document
  and storage, and navigating the window: each is undefined or blocked, while its own storage works.
- The link in Pepper's message opens the same preview. The login-only site shows the fallback with Open in browser.
- Delete is refused with a plain line while no token is saved, then, with one saved in the Vault, deletes the site on
  the stand-in and its record. The token appears in no answer, page or server log.
- At 390 px wide the page is one column and the preview covers the screen.

`OMB_PUBLISHED_APPS_REAL_SITES="https://one.netlify.app https://two.netlify.app"` also frames those public sites from a
link in a message, read-only.

Not proven here: a real Netlify account, the desktop app's own window (the Electron rules are asserted from source),
and a Team Cloud in the renderer.
