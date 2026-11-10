# Announcements: cards without a release

The app can show a card in its corner (a sponsor's offer, product news, a tip) that nobody shipped in a release. The cards
live in one file in this repository, [`announcements/announcements.json`](../announcements/announcements.json). Merge a
change to it on `main` and every install that runs this version or later picks it up within about an hour.

## How it works

- **One file on `main`.** The app's server downloads
  `https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/announcements/announcements.json` when a page of the app
  asks for the cards: at launch, then about hourly while the app is in use. Whoever can merge to `main` can publish a card;
  there is no other sign-in and no backend.
- **The server fetches, the page decides.** The desktop app's own server, a MausBot Cloud and a self-hosted server all
  download the file the same way (`server/announcements/feed.ts`) and hand the cards to their pages at
  `GET /api/announcements`. Each page then decides, from what it already knows, whether a card is for the person looking
  at it (`src/lib/announcements.ts`). Nothing about the person goes anywhere.
- **The same fetch as the model manifest.** Like `server/model-manifest/`, the server keeps a copy bundled with the
  release, a cache of the last good download on disk (`providers/announcements/` in the data folder, which backups and
  Move to Cloud leave out), and downloads at most once an hour (every five minutes after a failure). A download that
  fails, is slow (ten seconds at most), is larger than 64 KB, is not JSON or does not validate is dropped and the last
  good copy is kept. A page's first ask waits at most three seconds for the first download; nothing else ever waits for
  it, and nothing is shown when it fails. The two should share one helper once both are on `main`.
- **Cards, not pages.** The file carries words, a picture's address and one of a few button actions. The app draws the
  card with its own notice card (`src/components/AnnouncementCard.tsx`); nothing in the file is read as HTML or run.

### What the app sends

One plain GET of that public file, from the server: no cookie, no account, no install id, no version, no query string.
GitHub sees the server's IP address, as for any download. When a card has a picture, the person's browser loads it from
the same place, with no cookie and no referrer. Clicking a card's link opens its address exactly as the file has it,
in the system browser on the desktop (a new tab with no opener or referrer in a browser), with nothing added. With
analytics on, the app counts the card (see [Counting](#counting)).

Older versions of the app know nothing of this file and never download it.

## Publishing a card

1. Edit `announcements/announcements.json` on a branch: add a card to `cards` (the first card in the list that is for a
   person is the one they see, so order them by priority) and move `updatedAt` to now. Editors that read JSON Schema
   check the file as you type, from `announcements/announcements.schema.json`.
2. Check it: `node scripts/check-announcements.mjs` (add `--against origin/main` to also check `updatedAt` moved
   forward). CI runs the same check on every pull request and fails on any problem, so a bad edit cannot merge.
3. For a picture, add the file under `announcements/` (for example `announcements/images/phone-app.png`, PNG, JPEG or
   WebP, at most 200 KB, about 600 × 240 pixels) and point `image.url` at its raw address on `main`. It must be merged
   for the picture to load, so merge it with the card or before.
4. Open a pull request and merge it. Installs show the card within about an hour (GitHub's raw cache adds up to five
   minutes), each person once.

**To pull a card back:** delete it from the file (or set its `ends` to now), move `updatedAt` forward and merge. Within
about an hour no install shows it: a page that has it on screen drops it the next time it asks for the cards. Never reuse a card's `id` for a different card: people who saw the old one would
not see the new one, and a card brought back with its old id may reach people who closed it before.

**To change a live card**, edit it in place and keep its `id`: people who closed it will not see it again. A new `id`
shows it again to everyone.

## The format

```json
{
  "$schema": "./announcements.schema.json",
  "version": 1,
  "updatedAt": "2026-12-01T09:00:00Z",
  "cards": [
    {
      "id": "tip-first-api-key",
      "kind": "tip",
      "label": { "en": "Tip", "de": "Tipp" },
      "title": { "en": "Your bots can use any AI provider", "de": "Deine Bots können jeden KI-Anbieter nutzen" },
      "body": { "en": "Paste an API key once and every bot here can use it. You can change which model a bot uses at any time.",
                "de": "Füge einmal einen API-Schlüssel ein, und jeder Bot hier kann ihn nutzen. Das Modell eines Bots kannst du jederzeit ändern." },
      "primary": { "label": { "en": "Open API keys", "de": "API-Schlüssel öffnen" }, "action": { "open": "api_keys" } },
      "ends": "2027-02-01T00:00:00Z",
      "audience": { "people": "new", "when": ["no_api_key"], "surfaces": ["desktop", "cloud"] }
    },
    {
      "id": "sponsor-acme-credit-2026-12",
      "kind": "sponsor",
      "label": "Sponsor",
      "title": "Acme Inference: $5 of free credit",
      "body": "Acme Inference sponsors MausBot. New accounts get $5 of credit for any model they serve.",
      "primary": { "label": "Get a key", "action": { "open_url": "https://example.com/acme?utm_source=openmausbot&utm_medium=sponsorship" } },
      "secondary": { "label": "Add a key", "action": { "open": "api_keys" } },
      "starts": "2026-12-01T00:00:00Z",
      "ends": "2026-12-15T00:00:00Z",
      "audience": { "minVersion": "0.1.153", "plans": ["none", "cloud"] }
    }
  ]
}
```

(The tests read these two from `scripts/testing/fixtures/announcements.example.json`.)

### The file

| Field | Required | What it is |
| --- | --- | --- |
| `version` | yes | `1`. A file with any other version is ignored whole by this app. |
| `updatedAt` | yes | When the file last changed (ISO 8601 with a time zone). Installs keep the copy with the newest one, so a stale cached copy can never bring back a removed card. CI refuses an edit that does not move it forward. |
| `cards` | yes | At most 20 cards, in priority order. |
| `$schema` | no | `"./announcements.schema.json"`, for editors. |

### A card

| Field | Required | What it is |
| --- | --- | --- |
| `id` | yes | Stable and unique: 3–40 lowercase letters, digits and dashes, e.g. `phone-app-2026-12`. Each person sees each id once. |
| `kind` | yes | `sponsor`, `product` or `tip`. An app that does not know a kind skips the card. |
| `label` | sponsor: yes | A short word above the body, e.g. `Sponsor`, `New`, `Tip` (16 characters). A sponsor's card must say it is one. |
| `title` | yes | 60 characters. |
| `body` | yes | 240 characters, at most 3 lines (`\n` breaks a line). |
| `image` | no | Either `{ "url": "<raw address under announcements/ on main>", "alt": "<text>" }` (PNG, JPEG or WebP, shown the card's width and at most 120 pixels high), or `{ "mark": "<name>" }`, a built-in mark beside the title: `claude`, `codex`, `grok`, `kimi`, `modelgo`, `greenference`, `deepseek`, `copilot`, `kiro`. Without one, the card shows its kind's icon. An app that cannot read the picture shows the card without it. |
| `primary` | yes | The main button: `{ "label": <text, 24 characters>, "action": <action> }`. |
| `secondary` | no | A second, quieter button, in the same shape. Without one, the card has **Not now**. |
| `starts` | no | When it may first show (ISO 8601). |
| `ends` | yes | When it stops showing. After `starts`, at most 180 days after the day it merges. A card without `ends` is never shown. |
| `audience` | no | Who it is for; without it, everyone. |

**Text** is plain text: either one string (English), or one per language with English among them:
`{ "en": "Hello", "de": "Hallo", "pt-br": "Olá" }`. The app shows the person's language, else its language without the
region, else English. Languages: `en`, `de`, `es`, `fr`, `hi`, `ja`, `pt-br`, `zh`, `zh-tw`, `uk`, `vi`, `tr`, `pl`, `ru`,
`it`, `ko`. Nothing is read as markup: `<b>` shows as `<b>`, and there is no bold or link inside the body. Control
characters and characters that reorder or hide text are refused.

**An action** is exactly one of:

- `{ "open_url": "https://…" }`: opens the page outside the app (https only, no user name or password in it), with
  nothing added to the address. Put any campaign parameters in the address yourself.
- `{ "open": "<place>" }`: opens one of the app's own places: `api_keys` (Settings → API keys), `ai_engines` (Settings →
  AI engines), `connected_apps` (Connected apps), `new_bot` (makes a new bot, as the sidebar's New bot does) or `my_cloud`
  (Settings → MausBot Cloud). `api_keys`, `ai_engines` and `new_bot` change a place's settings, so a card with one of them
  is not shown to someone who cannot (a Team Cloud's members).

Anything else makes the card invalid.

**The audience** (every key given must match; a key or value this version does not know means the card does not match,
so a card written for a newer app never reaches an older one by accident):

| Key | Values | Matches |
| --- | --- | --- |
| `minVersion`, `maxVersion` | `"0.1.153"` | The page's app version, inclusive. A Cloud's page has its Cloud's version. |
| `platforms` | `mac`, `windows`, `linux`, `ios`, `android` | The device the page is open on. |
| `surfaces` | `desktop`, `cloud`, `server` | The desktop app's own page; a MausBot Cloud's page (in a browser or in the desktop's window); any other server's page (self-hosted, or the app in a browser). |
| `plans` | `none`, `cloud`, `team` | `none`: no Cloud plan of one's own (signed out, or a free account); `cloud`: a Cloud of one's own, or its page; `team`: a Team Cloud's page. Known on the desktop app's page and on a Cloud's page; a card with `plans` never shows on another server's page. |
| `people` | `new`, `existing` | `existing`: a bot here has answered someone before this launch; `new`: none has. |
| `languages` | the language codes above | The app's language, or its language without the region. |
| `when` | `no_api_key`, `one_bot_only`, `no_routine` | Every condition listed holds: no AI provider API key saved here; only one bot shown; no routine. |

To add a value or a condition, add it to `shared/announcements.ts` and its checks; an older app keeps ignoring cards
that use it.

## The rules the app keeps, whatever the file says

- **Once per person per `id`.** The app remembers a card someone closed or used the way it remembers the built-in sponsor card (`MODELGO_OFFER_NOTICE`):
  in the browser, in the desktop app's own record for every page its window shows (My Cloud's included), and in the
  workspace's record. On a Team Cloud the workspace record is the whole team's, so there it uses only the first two.
- **One card on screen, through the notice queue.** A remote card comes after everything else in
  `src/lib/notices.ts`'s queue that is due: the Grok Bot move, the What's new popup, the product-updates question, bots
  in two places, the Cloud trial and account notices, and the built-in sponsor and partner offers; only the GitHub star comes
  after it. A launch shows one notice, so a remote card waits for a launch nothing else claimed.
- **At most one remote card a launch**, and **at most one `sponsor` card in any 7 days** per person (counted from the day
  one was shown).
- **Never** in the launch whose welcome just finished, over MausBot's first-launch card, during a live call, or while a
  move to My Cloud is under way (the built-in sponsor card's exclusions).
- **Never on a branded build** (`brandStatus().source === "file"`), any kind, as the What's new popup.
- **Sponsor cards** also skip a desktop whose organization's policy limits the AI providers (company models only, or a
  list of allowed engines), and a Team Cloud's members who are not its owner or an admin
  (`SPONSOR_CARDS_FOR_TEAM_MEMBERS` in `src/lib/announcements.ts`, off).
- **Invalid is ignored.** A card that fails validation, has no `ends` or is past it is skipped; a file that fails as a
  whole is ignored and the last good copy kept. At most 20 cards and 64 KB are read.

## Turning it off

- **`OMB_DISABLE_ANNOUNCEMENTS=1`** in the server's environment stops the download and every remote card on that server's
  pages, the bundled ones included. For a self-hosted server or an open-source build that should never show them. The
  desktop app's own server inherits the app's environment, so it holds there when the app is started with it set.
- **No in-app switch governs these cards.** The app has no setting for promotional popups: the product-updates question is
  about email, and the usage-analytics switch only stops the counting. A person closes a card with Not now or the X, and
  never sees that card again.

## Counting

With usage analytics on, and only then (the same switch as every other event), each card sends one `announcement` event
per step: `{ id, kind, action }`, `action` being `shown`, `primary`, `secondary` or `close` (the X, Escape or Not now).
The `id` is the card's own id from this public file, the same for everyone. See [Usage analytics](analytics.md).

## Tests and previews

Tests never download the live file: `server/testing/setup.ts` and the verification server
(`scripts/control-omb.ts`, which the renderer previews and UI tests run on) set `OMB_DISABLE_ANNOUNCEMENTS=1`, so their
pages get no cards whatever `main` holds. The server's tests hand the store a fake fetch.

## Moving the built-in sponsor card into the feed later

The built-in sponsor card (`MODELGO_OFFER_NOTICE`) stays built in. To move it: publish a `sponsor` card with the same
words, its mark and `MODELGO_URL` as its `open_url`; release a version whose app treats the old seen id as the card's
(mark `announcement:<id>` seen when `modelgo-offer-2026-11` is), then remove the built-in card. Until every install runs
that version, older ones keep showing the built-in card.

## Design notes

- The fetch runs on the server, not in the page: a Cloud in a browser and the desktop app then behave the same, the page
  needs no new network permission, and many pages share one download an hour.
- The schema is `shared/announcements.ts` (zod). The JSON Schema beside the file is generated from it
  (`node scripts/check-announcements.mjs --write-schema`), and CI fails when the two differ. An install reads the file
  leniently (unknown fields are dropped, an unknown audience key is kept so the card matches no one); CI reads it
  strictly, where an unknown field is a typo.
