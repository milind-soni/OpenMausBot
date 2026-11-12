# The site record: `.netlify-site.json`

`deploy.mjs` writes one record for each site a bot publishes to the person's own Netlify account, and the server
writes the same record for an app a bot publishes with `publish_app` on the hosting the Cloud plan includes (see
"Included hosting" below). Other code may read it (for example, to list what bots published). Nothing else writes it;
the shape below is version 1 and stays stable: keys are added, never renamed or removed, and a change of meaning
raises `version`.

## Where it is

In the project folder the bot published from: the folder `deploy.mjs` ran in, or the one given with `--project`. That
is inside the bot's own folder, `<data folder>/workspaces/<bot id>/…/.netlify-site.json`, at any depth, so the bot a
record belongs to is the `<bot id>` part of its path. One project folder holds one record, for one site. It is a
dotfile: it is never uploaded with the site, and it never holds the token.

## Shape

```json
{
  "version": 1,
  "siteId": "3f2a6c1e-8a55-4b0c-9a50-1c2f6c1d9e11",
  "name": "bright-bakery-4f2a1c",
  "url": "https://bright-bakery-4f2a1c.netlify.app",
  "adminUrl": "https://app.netlify.com/projects/bright-bakery-4f2a1c",
  "title": "Bakery order page",
  "botId": "bot_1a2b3c",
  "botName": "Mira",
  "createdAt": "2026-11-11T20:41:07.512Z",
  "publishedAt": "2026-11-11T20:44:30.108Z",
  "deployId": "6913a0c2e4b0a1000812f3aa",
  "deployState": "ready",
  "access": "public"
}
```

| Key | Always there | What it is |
|---|---|---|
| `version` | yes | `1`. |
| `siteId` | yes | Netlify's id of the site. Letters, digits, `-` and `_`. |
| `name` | yes | Netlify's name of the site (its `netlify.app` subdomain). |
| `url` | yes | The site's public address, as Netlify gave it. |
| `adminUrl` | yes, on the person's own Netlify | The site's page in the person's Netlify account. |
| `hosting` | no | `included`: the app is on the Cloud plan's included hosting, not on the person's Netlify account. Absent: the person's own Netlify account. |
| `appKey` | with `hosting` | The app's key on the included hosting. |
| `title` | yes | What the bot called the site (`--title`), one line, at most 120 characters. The site's `name` until a title is given. |
| `createdAt` | yes | When the site was created, ISO 8601 in UTC. |
| `botName` | no | The bot's name as it gave it (`--bot-name`), one line, at most 80 characters. |
| `botId` | no | The bot's id, when the command's environment has `OMB_BOT_ID`. Prefer the record's path. |
| `deployId` | no | Netlify's id of the latest production deploy that was started. Absent until the first one starts. |
| `deployState` | no | That deploy's state when last seen: Netlify's own word (`uploading`, `uploaded`, `processing`, `ready`, `error`, …). Only `ready` means it is live. |
| `publishedAt` | no | When the latest production deploy was first seen ready, ISO 8601 in UTC. While a newer deploy is still being processed it is the time of the one before. Absent until a deploy has been ready. |
| `access` | no | `public`: the link answered without a login. `private`: it asked for a Netlify login (a new account's default). As last checked. |

`deploy.mjs --delete` deletes the site from Netlify and then removes the record; the record stays when Netlify
refuses. Draft deploys (`--draft`) change nothing in the record. A record written before version 1 has only `siteId`, `name`,
`url` and `adminUrl`; a reader should treat every key but `siteId` and `url` as optional, and ignore keys it does not
know.

## Included hosting

A record with `"hosting": "included"` is an app on the hosting the Cloud plan includes. It has no Netlify account
behind it that the person can open, so there is no `adminUrl`, and `name` is absent.

```json
{
  "version": 1,
  "hosting": "included",
  "appKey": "app-5d0c1b7e9a3f4c62b8e1d2a4f6c80913",
  "siteId": "app-5d0c1b7e9a3f4c62b8e1d2a4f6c80913",
  "url": "https://mb-3f9c2a17d04e8b65.netlify.app/",
  "title": "Bakery order page",
  "botId": "bot_1a2b3c",
  "botName": "Mira",
  "createdAt": "2026-11-11T20:41:07.512Z",
  "publishedAt": "2026-11-11T20:44:30.108Z",
  "deployState": "ready",
  "access": "public"
}
```

- `siteId` repeats `appKey`, so a reader that knows only version 1's first keys still finds `siteId` and `url`. It is
  not a Netlify site id: `deploy.mjs` refuses to deploy, check or delete from a project folder whose record says
  `"hosting": "included"`.
- `deployState` is the relay's word for the latest publish: `uploading`, `processing`, `ready`, `failed` or
  `taken_down`. `url` is absent until the app has an address.
- The key is made from the bot and the project folder, so one project folder is one app, and a record copied to
  another folder names nothing there. A reader that lists apps takes the address, title and state from the plan's
  hosting by that key, never from the record.
- `publish_app` with `action: "delete"`, and Delete on the Published apps page, delete the app and then remove the
  record.
