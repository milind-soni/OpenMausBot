# Included app hosting

A Cloud plan includes hosting for the sites and simple apps a bot builds, a number of apps per plan, on MausBot's
hosting account. The key to that account stays on the Admin. A Cloud home gets the Admin's relay address and a token
of its own (`OMB_CLOUD_HOSTING_URL` and `OMB_CLOUD_HOSTING_TOKEN`), held in the server's memory and never given to a
bot, the bot box, a client, a record or a log. A bot publishes with the `publish_app` tool: the server reads the folder
from the bot's own working folder, sends it through the relay and leaves a `.netlify-site.json` record
(`skills/publish-to-netlify/site-record.md`, "Included hosting"), which the [Published apps](published-apps.md) page
lists with the plan's count. Where the Admin gave no relay (off a Cloud, a trial, an older Admin) nothing changes: no
tool, no count, and the skill uses the person's own Netlify account.

Nothing here runs against the real Admin or the real Netlify. `server/testing/fake-app-hosting.ts` is a loopback
stand-in for the relay, written from its contract; it also serves what is published under `/live/<site>/`.

## The relay's client and the publish

```sh
pnpm exec vitest run server/host/included-hosting.test.ts server/host/app-publisher.test.ts server/routes/app-hosting.test.ts
```

- The credential is held only with both values, over https (loopback for the stand-in), with nothing else in the
  address. The token goes as a bearer to the relay and to no other address, the app's own included.
- An app's key is made from the bot and its project folder, so a later publish updates the same app and no record a
  bot wrote can name another bot's or another folder's app.
- The folder must be inside the bot's own folders: another bot's folder, a path that climbs out with `..`, a link out,
  the data folder and `/` are refused before the relay is asked anything. Dotfiles, env files, keys, `node_modules` and
  links are left out and named; the filter is the publish helper's, checked path by path against
  `skills/publish-to-netlify/deploy.mjs`. A record swapped for a link is replaced, never written through.
- A project lives in the bot's shared folder (`workspaces/<bot>/sites/<name>`), which every conversation with the bot
  reaches: a relative `path` is read there first, so a second conversation publishes the same app to the same link,
  and `check_app_hosting` with no path lists the projects already published from the turn's folders. A new app
  published from one conversation's own folder is published, with a note that no other conversation will find it.
  The helper for the person's own Netlify account does the same with `--project`
  (`server/skill-publish-to-netlify.test.ts`).
- Only the files the relay does not hold are uploaded. The publish waits for `ready`, opens a new app to everyone
  where the relay still keeps new apps private, and checks that the link answers as `text/html`. A publish still being
  processed is said to be so, not live and not failed, and `check_app_hosting` picks it up.
- Redirects, `netlify.toml`, a `netlify` folder and anything over the plan's sizes are refused before anything is
  sent, with the offer of the person's own Netlify account. Every refusal of the relay becomes the app's own sentence
  with the relay's numbers (`3 of 10`), never the relay's text.
- A project already on the person's own Netlify account stays there, and `deploy.mjs` refuses a project whose record
  says `"hosting": "included"` (`server/skill-publish-to-netlify.test.ts`).

## The list, who sees what, and Delete

```sh
pnpm exec vitest run server/host/published-apps-included.test.ts server/routes/published-apps.test.ts
```

- An included app is listed under the bot whose folder holds its record, with the address, title and state the relay
  gives. A record copied into another bot's folder claims nothing.
- The page's count is the whole Cloud's, so a team's. It is absent where there is no included hosting, where the plan
  includes none and none is published, and while the relay can't be reached (the other apps are still listed).
- An app MausBot took down, and one that was never live, are listed as such with no address offered as live.
- An app whose project folder is gone is shown to a viewer who sees everything on a person's own Cloud, so its place
  can be freed. On a Team Cloud it is shown to nobody, an Admin included: it belongs to no conversation.
- On a Team Cloud the same rules as every other published app: a member sees the apps from their own chats and the
  team's conversations, an Admin nothing from a member's private chat, and an id or address someone is not shown
  answers 404. A member deletes the app from their own chat; a member who only chats with a shared bot is refused for
  the team's app; the bot's own person and an Admin may.
- Delete asks the relay (`DELETE /apps/<key>`), then removes the record; the bot's files stay.

## A real server, a real agents proxy

```sh
pnpm exec vitest run server/included-hosting.e2e.test.ts
```

Four launched fixtures. In the last, a second conversation with the same bot finds the app in the bot's shared folder
and publishes it again to the same link. Without the relay's address and token a bot is shown neither `publish_app` nor
`check_app_hosting` and `GET /api/published-apps` has no count. With them, a scripted bot calls the real tools: the
count, a publish of its own folder (its `.env` left out), and the app's state; a path to its neighbour's folder, by
full path and by `..`, is refused in plain words. The app is listed with `included: { used: 1, max: 10 }`, and deleted
with `POST /api/published-apps/delete`. The token is in none of: the engine's launch (arguments, environment,
prompts), the tool results, the list, `GET /api/config`, the server's log, or any file in the data folder. With a plan
of one app, the second publish is refused with the numbers and the offer of the person's own account.

## Renderer and server, end to end

```sh
OMB_UI_EVIDENCE_DIR=evidence/included-hosting pnpm exec vitest run scripts/testing/included-hosting-ui.e2e.test.ts
```

It runs when an agent-browser binary resolves, as in [Chat UI, driven headlessly](chat-ui.md), and is skipped
otherwise. The launcher lets `OMB_CLOUD_HOSTING_URL` cross only when it is a loopback address, and the token only with
it.

- The empty page already says "0 of 3 apps included in your plan".
- Pepper publishes two folders through the tool's route; a third site goes to the Netlify stand-in with the skill's
  helper. The page shows three cards, each saying where it is hosted ("Included hosting", "Your Netlify"), and "2 of
  3". An included card has Preview, Open, Copy link, Ask and Delete, and no Netlify page to manage.
- Preview frames the included app beside Pepper's chat, in the sandbox every published site gets.
- After a takedown on the stand-in the card says "Taken down", offers only Ask and Delete, and still counts.
- Delete removes the app on the stand-in and its record; the count drops; the bot's files stay; Netlify is not called.
- The relay's token is in no answer, record, page, console line or server log.

The component tests for the cards and the count are in `src/components/published-apps/PublishedAppsPage.test.ts`; the
tools' place in the catalog is pinned in `server/drivers/agents-catalog-wire.test.ts` and
`server/drivers/agents-bridge-wire.test.ts`.

Not proven here: the real Admin's relay and the real Netlify (the stand-in is written from the contract, and the
relay's follow-up that makes every publish public at once is covered by both of the stand-in's modes); a Cloud home
started by its launcher with the token on its secrets pipe; a Team Cloud in the renderer; and a real engine choosing
to follow the skill's rule to ask before publishing.
