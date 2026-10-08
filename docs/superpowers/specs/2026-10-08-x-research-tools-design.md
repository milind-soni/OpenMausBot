# X Research Tools

## Summary

Grok Bot can search, read, and monitor X. Squad does the same through
third-party scrapers, so its users never connect an X account. MausBot today
reaches X only through the built-in browser (slow, token-heavy, needs an X
login) or the Composio `twitter` toolkit (off on the managed service; needs the
user's own X Developer app).

Add four read-only X tools to the built-in `agents` tool server, backed by
twitterapi.io with a key the user pastes into Settings. A bot gets the tools
only when the key is saved **and** the user has turned X research on for that
bot. With a routine, the same tools cover monitoring.

This is step 1. Step 2 (later, separate spec) routes the same tools through the
MausBot managed service so users need no scraper key at all.

## Goals

- A bot the user switched on can search X, read an account's recent posts, read
  one post with its replies, and look up a profile, without an X account.
- A routine can check X on a schedule and report only posts it has not seen.
- Every engine that mounts the `agents` server gets the tools (Claude, Codex,
  Grok, OpenCode, Pi, the ACP harnesses, the OpenAI-compatible chat engines).
- The scraper key stays in the server and the encrypted credential store. It
  never reaches an engine, a prompt, or the renderer.
- The scraper sits behind one small module, so step 2 or another scraper
  replaces that module only.

## Non-goals

- Posting, liking, replying, following, or DMs. The tools only read.
- The managed (no-key) service. That is step 2.
- Other scrapers, routing between scrapers, or a shared result cache.
- A spend cap in MausBot. twitterapi.io is prepaid, so the user's balance is
  the ceiling.
- Phone UI. Phones cannot change bot settings or keys; they show the bot's
  replies and tool activity as they already do.
- Streaming or webhook monitoring. Monitoring is a routine plus `sinceId`.

## What the user sees

1. **Settings → API keys** has a new row, **X research (twitterapi.io)**:
   paste-to-save, Clear, and **Test**. Test reports either
   "Works · about $4.20 of credit left" or the reason it failed. The row links
   to twitterapi.io to get a key.
2. **Bot settings → Access** has a new **X research** card with one switch,
   off by default. With no key saved, the switch is disabled and the card says
   "Add a twitterapi.io key in Settings → API keys" with a link there.
3. With both set, the user asks the bot "what are people saying about MausBot
   on X this week?" and the bot answers from real posts with links.
4. The Activity log lists the calls under **X** ("Searched X", "Read X posts",
   "Read an X post", "Looked up an X profile").

Imported bots and shared bot packages arrive with the switch off. No package
code changes: `package-import.ts` creates fresh bots, and an absent field means
off.

## The four tools

All four live in `server/drivers/agents-catalog.ts`, gated like
`send_voice_note`. Descriptions tell the bot that each call spends the user's
twitterapi.io credit, so it should prefer one well-filtered search over many
broad ones.

| Tool | Inputs | Returns |
| - | - | - |
| `x_search` | `query` (required; X search syntax such as `from:`, `to:`, `since:`, `until:`, `min_faves:`, `-filter:replies`, `lang:`), `sort` (`latest` default, or `top`), `limit` (1–50, default 20), `sinceId` (optional) | posts |
| `x_user_posts` | `handle` (required; `@` optional), `limit` (1–50, default 20), `sinceId` (optional), `includeReplies` (default false) | posts |
| `x_post` | `post` (required; an `x.com` or `twitter.com` status URL, or a bare id), `replies` (default false: when true, also the first page of up to 20 replies) | one post, optional replies |
| `x_profile` | `handle` (required) | profile |

Limits are 50, not 100: at 20 posts per scraper page that is at most three
pages per call, and 50 compact posts stay under the 24,000-character
`capResult` threshold, so the bot rarely needs `tool_result_read`.

### Result shape

Results are compact JSON text, never the scraper's raw JSON.

```json
{
  "posts": [
    {
      "id": "2107987482155561188",
      "url": "https://x.com/pbteja1998/status/2107987482155561188",
      "author": "@pbteja1998",
      "authorName": "Bhanu Teja P",
      "createdAt": "2026-10-08T00:12:34.000Z",
      "text": "You can do it in Squad too - no need to connect any X account.",
      "likes": 18, "reposts": 2, "replies": 5, "quotes": 0, "views": 3800,
      "isReply": false,
      "quoted": { "url": "https://x.com/…", "author": "@…", "text": "Grok Bot can now…" }
    }
  ],
  "newestId": "2107987482155561188",
  "more": true
}
```

- `text` is cut at 1,500 characters and `quoted.text` at 300, each with `…`.
- `quoted` appears only for quote posts. Fields the scraper omits are left out,
  not filled with zero.
- `newestId` is the highest id in the result (absent when there are no posts).
  The `x_search` and `x_user_posts` descriptions tell a routine to keep it and
  pass it back as `sinceId` next run.
- `more` is true when the scraper has another page.
- A profile is `{ handle, name, bio, location, website, followers, following,
  posts, verified, createdAt, url }`.

### `sinceId`

- `x_search` appends ` since_id:<id>` to the query, and also drops any post
  whose id is not greater than `sinceId` (ids compared as `BigInt`).
- `x_user_posts` pages newest-first and stops at the first post whose id is not
  greater than `sinceId`.
- `sinceId` must be all digits; anything else is a 400 with a plain message.

## Architecture

```
bot ──tools/call──▶ agents-proxy (stdio)
                     └─ agents-call.ts handler ──POST /api/internal/x/*──▶ server
                                                   server/routes/x-research.ts
                                                     ├─ re-checks key + bot switch
                                                     └─ server/x-research.ts ──HTTPS──▶ api.twitterapi.io
```

### `server/x-research.ts` (new): the scraper client

- `createTwitterApiClient({ key, fetcher? })` returns
  `{ search, userPosts, post, profile, accountInfo }`. Each method returns the
  compact shapes above or throws an `XResearchError` with a `code`
  (`bad_key`, `no_credit`, `rate_limited`, `not_found`, `unavailable`,
  `bad_input`) and a plain-language `message`.
- Endpoints: `GET /twitter/tweet/advanced_search` (`query`, `queryType`
  `Latest`|`Top`, `cursor`), `GET /twitter/user/last_tweets` (`userName`,
  `includeReplies`, `cursor`), `GET /twitter/tweets` (`tweet_ids`),
  `GET /twitter/tweet/replies` (`tweetId`), `GET /twitter/user/info`
  (`userName`), `GET /oapi/my/info` (`recharge_credits`, used by Test).
- Auth header `X-API-Key`. Base URL `https://api.twitterapi.io`.
- Each request: `AbortSignal.timeout(15_000)`, `redirect: "error"`, body read
  with a 2 MiB cap (the `readBounded` pattern from `server/bot-directory.ts`),
  parsed with lenient zod schemas (unknown fields pass, missing optional
  fields are fine). The fetcher is injectable for tests.
- Pure mapping helpers (`toPost`, `toProfile`, `parsePostRef`,
  `normalizeHandle`) are exported and tested on their own.

### `server/routes/x-research.ts` (new): internal routes

- `createXResearchRoutes(deps)` per `server/routes/README.md`; no new path guard
  in `server/index.ts` (the route ratchet test stays at its current count).
- `POST /api/internal/x/search`, `/user-posts`, `/post`, `/profile`. Bodies are
  validated with zod; bad input is a 400 with the reason.
- Every call checks, in order: a valid `agents` internal capability (injected
  from index.ts, like `workspaceBackupRoutes`), a saved key, and
  `store.bot(capability.botId)?.xResearch === true`. Either missing is a 403
  with the plain message below, so a stale tool list cannot spend credit.
- `XResearchError` codes map to HTTP statuses (400/401/402/404/429/502) and the
  message is returned as `{ error }`.

### `server/drivers/agents-call.ts`: handlers

Four handlers that validate arguments, call the route through
`client.api(...)`, and return the JSON text. Route errors come back as the
tool's error text unchanged.

### Gating in the catalog

- `server/index.ts` `agentsIntegration()` sets
  `OMB_X_RESEARCH: cfg.twitterapi?.key && store.bot(botId)?.xResearch === true ? "1" : "0"`.
- `catalogProfileFromEnv` reads it into `profile.xResearch`; `catalogTools()`
  hides `X_TOOL_NAMES` unless it is true, the same way `VOICE_TOOL_NAMES` works.
- The tools are not in `EXTERNAL_TOOL_NAMES`.
- Per-bot tool scopes (`mcp:agents:x_search`) already apply with no new code.

### Plain-language errors

| Case | Message the bot gets |
| - | - |
| No key | "X research isn't set up. Add a twitterapi.io key in Settings → API keys." |
| Bot switch off | "X research is off for this bot. Turn it on in this bot's settings under Access." |
| Key rejected | "twitterapi.io rejected the API key. Check it in Settings → API keys." |
| No credit | "The twitterapi.io balance has run out. Top up at twitterapi.io, then try again." |
| Rate limited | "twitterapi.io is rate-limiting requests. Wait a minute and try again." |
| Account not found | "No X account named @<handle>." |
| Post not found | "That X post was not found. It may be deleted or private." |
| Timeout, 5xx, bad JSON | "twitterapi.io didn't answer properly. Try again shortly." |

## Key storage

The key follows the xAI key everywhere it goes. Config section `twitterapi`,
field `key`, env `TWITTERAPI_KEY`, Electron credential name `twitterapiKey`.

- `server/config.ts`: schema, `AppConfig`, env override, `syncCredentialEnv`,
  `WORKSPACE_CREDENTIAL_ENV` (strips it from engine children), `saveConfig`.
- `electron/workspace-credentials.mjs`, `electron/main.mjs` (`CREDENTIAL_PATCH`),
  `electron/diagnostics.mjs` (`CREDENTIAL_ENV_NAMES` plus its test),
  `src/types/ogb.d.ts` (`setCredential` names).
- `server/index.ts`: `configStatus()` reports `twitterapi: { configured }`
  (never the value); the external-secret tombstone list. It stays out of the
  `hostedModels` list.
- `src/state/store.tsx` `ConfigStatus`.

## Settings UI

- `src/components/ApiKeys.tsx`: a `twitterapi` section with label, description,
  link, and placeholder; it saves through the Electron credential slot in the
  desktop app. Test calls a check that hits `GET /oapi/my/info` and shows the
  remaining credit in dollars (`recharge_credits / 100_000`; twitterapi.io
  prices 15 credits at $0.00015). The check goes through `POST /api/keys/test`
  with a new `twitterapi` kind handled outside the model-provider path.
- `src/components/SettingsModal.tsx`: render the row in the connections card
  and add search keywords ("x", "twitter", "scraper").
- `src/components/bot-settings/AccessSection.tsx`: the X research card with a
  `Switch` that patches `xResearch`.
- Bot field `xResearch?: boolean` in `shared/wire.ts` and `src/state/store.tsx`;
  `PATCH /api/bots/:id` accepts it as a boolean (next to `voiceNotes`);
  `src/state/bot-patch-queue.ts` allows it. A paired phone cannot set it:
  phone tokens may patch only the display fields in `CLIENT_BOT_PATCH_FIELDS`
  (`server/request-auth.ts`), and a test pins that `xResearch` is refused.
  Team backups do not carry it (they do not carry `voiceNotes` either), so a
  restored bot starts with it off.
- English strings in `src/locales/en.json`. Other locales fall back to English,
  as other new strings do.

## Activity log

`server/activity.ts` `describeTool` maps `mcp__agents__x_search`,
`x_user_posts`, `x_post`, and `x_profile` to app **X** with the four labels
above, instead of the generic "Team". Bare names that Codex records keep
today's behaviour.

## Docs

`apps/docs/content/docs/connected-apps/index.mdx`, in "Connect X (Twitter)":
add that bots can search and read X without an X account through X research
(Settings → API keys, then the bot's Access settings), and that the Composio
connector is only needed for posting.

## Testing

- `server/x-research.test.ts` with an injected fetcher:
  - mapping of posts, quoted posts, profiles, and missing fields;
  - text truncation;
  - `parsePostRef` for x.com URLs, twitter.com URLs, and bare ids;
  - `sinceId` filtering and early stop;
  - pagination up to `limit`;
  - each error code from HTTP status and from `status: "error"` bodies;
  - the timeout and the body cap.
- `server/routes/x-research.test.ts`: refused with no capability, no key, or the
  bot switch off; bad input is a 400; success passes the compact result through.
- `server/drivers/agents-call.test.ts`: the four handlers call the right routes
  and surface route errors.
- `server/drivers/agents-catalog-wire.test.ts`: new `+x` profiles, goldens
  regenerated, `BUDGET_BASELINE` raised by hand for those profiles only; the
  existing profiles stay byte-identical.
- `server/activity.test.ts`: the four labels.
- Request-auth test: a phone token's `PATCH /api/bots/:id` with `xResearch` is
  refused; the desktop's patch is accepted.
- `electron/diagnostics.test.mjs`: the mirror list includes `TWITTERAPI_KEY`.
- Config tests: the key is stripped from engine environments and never appears
  in `configStatus`.
- Manual: an OMB2 build. Omkar pastes a real twitterapi.io key, Test shows the
  balance, he turns X on for one bot, asks for this week's MausBot mentions,
  then sets an hourly routine and checks that the second run reports only new
  posts.

## To verify during the build

- That `since_id:` works inside twitterapi.io's advanced search query. If it
  does not, the client-side filter alone still gives correct results; it just
  costs one page per run.
- The real error bodies for a bad key and an empty balance, so the error
  mapping uses them rather than guesses.
- The credit-to-dollar rate shown by Test.
