# X Research Tools

## Summary

Grok Bot can search, read, and monitor X. Squad does the same through
third-party scrapers, routed to the best one per job, so its users never
connect an X account. MausBot today reaches X only through the built-in browser
(slow, token-heavy, needs an X login) or the Composio `twitter` toolkit (off on
the managed service; needs the user's own X Developer app).

Add four read-only X tools to the built-in `agents` tool server, backed by
[treg](https://treg.to) ("OpenRouter for agent tools") with a token the user
pastes into Settings. treg sells per-call access to several X scrapers
(anyapi, tikhub, justoneapi and others) and routes between them. A bot gets the
tools only when the token is saved **and** the user has turned X research on
for that bot. With a routine, the same tools cover monitoring.

This is step 1. Step 2 (later, separate spec) runs the same tools on
MausBot's own treg token, tagged per customer with `X-Treg-Meta` and billed
from `usage/by-tag`, so users need no token at all. treg's licence allows using
the hosted treg.to API inside our product this way.

## Why treg

Published catalog prices, checked 2026-10-08:

| Job | treg | twitterapi.io | X official API |
| - | - | - | - |
| Search, about 20 posts | $0.00075 per call | about $0.003 | about $0.10 |
| An account's posts | $0.0005 per call | about $0.003 | about $0.10 |
| Replies to a post | $0.0005 per call | about $0.003 | none |
| Profile | $0.00022 per call | $0.00018 | $0.01 |

- Calls that fail or come back empty on per-success providers are free.
- treg falls back across scrapers, which addresses the main risk of a scraper
  being blocked by X.
- The same token later opens YouTube, Reddit, LinkedIn and SEO research without
  more vendor accounts.
- Risk: treg is young (its repository dates from July 2026). The scraper sits
  behind one module, so it can be replaced.

## Goals

- A bot the user switched on can search X, read an account's recent posts, read
  one post with its replies, and look up a profile, without an X account.
- A routine can check X on a schedule and report only posts it has not seen.
- Every engine that mounts the `agents` server gets the tools (Claude, Codex,
  Grok, OpenCode, Pi, the ACP harnesses, the OpenAI-compatible chat engines).
- The token stays in the server and the encrypted credential store. It never
  reaches an engine, a prompt, or the renderer.
- The provider sits behind one module, so step 2 or another provider replaces
  that module only.

## Non-goals

- Posting, liking, replying, following, or DMs. The tools only read.
- The managed (no-token) service. That is step 2.
- treg's other catalogs (YouTube, Reddit, SEO). Later, on the same token.
- A spend cap in MausBot beyond a per-call ceiling. treg is prepaid, so the
  balance is the ceiling.
- Phone UI. Phones cannot change bot settings or keys; they show the bot's
  replies and tool activity as they already do.
- Streaming or webhook monitoring. Monitoring is a routine plus `sinceId`.

## What the user sees

1. **Settings → API keys** has a new row, **treg token (X research)**:
   paste-to-save, Clear, and **Test**. Test reports either
   "Works. $0.97 left on treg." or the reason it failed. The row links to
   treg.to.
2. **Bot settings → Access** has a new **X research** card with one switch,
   off by default. With no token saved, the switch is disabled and the card says
   "Add a treg token in Settings → API keys" with a link there.
3. With both set, the user asks the bot "what are people saying about MausBot
   on X this week?" and the bot answers from real posts with links.
4. The Activity log lists the calls under **X** ("Searched X", "Read X posts",
   "Read an X post", "Looked up an X profile").

Imported bots and shared bot packages arrive with the switch off. No package
code changes: `package-import.ts` creates fresh bots, and an absent field means
off.

## The four tools

All four live in `server/drivers/agents-catalog.ts`, gated like
`send_voice_note`. Descriptions tell the bot that each call spends a fraction
of a cent of the user's treg balance, so it should prefer one well-filtered
search over many broad ones.

| Tool | Inputs | Returns |
| - | - | - |
| `x_search` | `query` (required; X search syntax such as `from:`, `to:`, `since:`, `until:`, `min_faves:`, `-filter:replies`, `lang:`), `sort` (`latest` default, or `top`), `limit` (1–50, default 20), `sinceId` (optional) | posts |
| `x_user_posts` | `handle` (required; `@` optional), `limit` (1–50, default 20), `sinceId` (optional), `includeReplies` (default false) | posts |
| `x_post` | `post` (required; an `x.com` or `twitter.com` status URL, or a bare id), `replies` (default false: when true, also the first page of up to 20 replies) | one post, optional replies |
| `x_profile` | `handle` (required) | profile |

At most 50 posts per call. Long posts can still push 50 past the 24,000-character
`capResult` threshold, so the client drops trailing posts to stay under 22,000
characters and sets `more`; `newestId` and `more` come first in the JSON so no
cut can hide them.

### Result shape

Results are compact JSON text, never a scraper's raw JSON.

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

- `text` is cut at 1,500 characters and `quoted.text` at 300, each with `…`,
  never inside an emoji.
- `quoted` appears only for quote posts. Fields the scraper omits are left out,
  not filled with zero.
- `newestId` is the highest id in the result (absent when there are no posts).
  The `x_search` and `x_user_posts` descriptions tell a routine to keep it and
  pass it back as `sinceId` next run.
- `more` is true when another page exists.
- A profile is `{ handle, name, bio, location, website, followers, following,
  posts, verified, createdAt, url }`, each present only when treg returns it.

### `sinceId`

- `x_search` appends ` since_id:<id>` to the query, and also drops any post
  whose id is not greater than `sinceId` (ids compared as `BigInt`).
- `x_user_posts` reads newest first. Every row of a fetched page is read (the
  page is paid for), old ones skipped; an old post past a page's first row ends
  the paging. A pinned post is never taken as that signal.
- `sinceId` must be all digits; anything else is a 400 with a plain message.

## Architecture

```
bot ──tools/call──▶ agents-proxy (stdio)
                     └─ agents-call.ts handler ──POST /api/internal/x/*──▶ server
                                                   server/routes/x-research.ts
                                                     ├─ re-checks token + bot switch
                                                     └─ server/x-research.ts ──HTTPS──▶ treg.to/call/<endpoint>
```

### `server/x-research.ts` (new): the provider client

- `createTregXClient({ token, fetcher?, baseUrl?, timeoutMs? })` returns
  `{ search, userPosts, post, profile, accountInfo }`. Each method returns the
  compact shapes above or throws an `XResearchError` with a `code`
  (`bad_key`, `no_credit`, `rate_limited`, `not_found`, `unavailable`,
  `bad_input`) and a plain-language `message`.
- Each job calls the cheapest scraper treg lists for it with full options
  (paging, sort, limit). If that call fails with `unavailable`, the client tries
  treg's routed endpoint once, which waterfalls through the other scrapers
  (one page, no options):

  | Job | Primary (`POST /call/<id>`) | Fallback |
  | - | - | - |
  | search | `anyapi.x.search.posts` `{query, queryType, limit, cursor}` | `treg.x.search.posts` `{q}` |
  | account posts | `anyapi.x.user.posts` `{handle, limit, cursor}` | `treg.x.user.posts` `{username}` |
  | one post | `anyapi.twitter.tweet` `{url}` | none |
  | replies | `anyapi.x.post.comments` `{url, limit}` | `treg.x.post.comments` `{tweet_id}` |
  | profile | `treg.x.user.profile` `{username}` (routed; normalized output) | (routing is the fallback) |
  | Test | `GET /auth/me` → `org_id`, then `GET /orgs/{org_id}/balance` → `balance_micro` | none |

- `OMB_TREG_URL` (environment only) points the client at a self-hosted treg
  registry or a test's loopback stub instead of treg.to. The verification
  launcher lets it cross into a fixture only as `http://127.0.0.1:<port>`.
- Every request carries `X-Treg-Token`; every `/call/` also carries
  `X-Treg-Route-Max-Cost: 0.05`, well above any of these prices, so a mispriced
  route cannot drain the balance. 30 s timeout, `redirect: "error"`, 2 MiB body
  cap. The fetcher is injectable for tests.
- Scrapers name the same fields differently (`likeCount`, `likes`,
  `favorite_count`; `authorUsername`, `authorHandle`, X's own
  `core.user_results…screen_name`). `toPost` reads each field through a short
  alias list and drops a row with no usable id. Ids are taken only as digit
  strings or safe integers.
- Pure helpers (`toPost`, `parsePostRef`, `normalizeHandle`) are exported and
  tested on their own. Links may be typed without `https://`; X's own pages
  (`home`, `search`, `i/…`, `explore`…) are never read as handles.

### `server/routes/x-research.ts` (new): internal routes

- `createXResearchInternalRoutes(deps)` per `server/routes/README.md`. It is
  called from inside index.ts's `/api/internal/` block after the capability
  bearer is checked. No new `path ===` guard in `server/index.ts` (the route
  ratchet test stays at its current count).
- `POST /api/internal/x/search`, `/user-posts`, `/post`, `/profile`. Bodies are
  validated with zod; bad input is a 400 with the reason.
- Every call checks a saved token and `store.bot(capability.botId)?.xResearch
  === true`. Either missing is a 403 with the plain message below, so a stale
  tool list cannot spend credit. Both are read per request.
- Status codes: `bad_input` 400, `not_found` 404, every provider failure 502.
  The body is `{ error, code }`. 401 is never used: on internal routes it means
  the turn's capability expired.
- `createXResearchKeyTestRoute(deps)` serves the Settings Test at
  `POST /api/x-research/test` (admin-only, like every route not opened to
  clients). It answers `{ ok: true, dollars }` or `{ ok: false, reason, message }`.

### `server/drivers/agents-call.ts`: handlers

Four names, one branch: post the arguments to the route through
`client.apiResponse(...)` and return the JSON text. A route refusal comes back
as the tool's error text unchanged.

### Gating in the catalog

- `server/index.ts` `agentsIntegration()` sets
  `OMB_X_RESEARCH: cfg.treg?.token && store.bot(botId)?.xResearch === true ? "1" : "0"`.
- `catalogProfileFromEnv` reads it into `profile.xResearch`; `catalogTools()`
  hides `X_TOOL_NAMES` unless it is true, the same way `VOICE_TOOL_NAMES` works.
- The tools are not in `EXTERNAL_TOOL_NAMES`.
- Per-bot tool scopes (`mcp:agents:x_search`) already apply with no new code.

### Plain-language errors

| Case | Message the bot gets |
| - | - |
| No token | "X research isn't set up. Add a treg token in Settings → API keys." |
| Bot switch off | "X research is off for this bot. Turn it on in this bot's settings under Access." |
| Token rejected (401/403) | "treg rejected the token. Check it in Settings → API keys." |
| Balance empty (402, not `route_max_cost`) | "The treg balance has run out. Top up at treg.to, then try again." |
| Rate limited (429) | "treg is rate-limiting requests. Wait a minute and try again." |
| Malformed request (422) | "treg refused that request. Check the query, handle or post link." |
| Account not found | "No X account named @<handle>." |
| Post not found | "That X post was not found. It may be deleted or private." |
| Anything else (404, 5xx, 503 capacity, `route_max_cost`, bad JSON, timeout) | "X research couldn't reach a working X source through treg. Try again shortly." |

## Token storage

The token follows the xAI key everywhere it goes. Config section `treg`, field
`token`, env `OMB_TREG_TOKEN` (the `OMB_` prefix every non-model key uses),
Electron credential name `tregToken`.

- `server/config.ts`: schema, `AppConfig`, env override, `syncCredentialEnv`,
  `WORKSPACE_CREDENTIAL_ENV` (strips it from engine children), `saveConfig`.
- `electron/workspace-credentials.mjs` (boot migration into the encrypted
  `credentials.bin`), `electron/diagnostics.mjs` (`CREDENTIAL_ENV_NAMES` plus
  its parity test).
- `server/index.ts`: `configStatus()` reports `treg: { configured }`, never the
  value.
- `src/state/store.tsx` `ConfigStatus` and its live-frame pick list.

## Settings UI

- `src/components/ApiKeys.tsx`: a `treg` section with label, description and
  link. In the desktop app it saves through `credential:set` (the encrypted
  store), like Box and OpenCode Go, so Clear also removes the stored copy; the
  external save leaves an empty tombstone in config.json. Browsers and dev
  builds save through `PUT /api/config`. Test calls
  `POST /api/x-research/test` and shows the balance in dollars.
- `src/components/SettingsModal.tsx`: render the row under Integrations, after
  Box, and add search keywords ("x", "twitter", "treg", "scraper").
- `src/components/bot-settings/AccessSection.tsx`: the X research card with a
  `Switch` that patches `xResearch`.
- Bot field `xResearch?: boolean` in `shared/wire.ts` and `src/state/store.tsx`;
  `PATCH /api/bots/:id` accepts it as a boolean (next to `voiceNotes`); the
  card is hidden while a bot or the New bot defaults are being drafted;
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
(a treg token in Settings → API keys, then the bot's Access settings), and that
the Composio connector is only needed for posting.

## Testing

- `server/x-research.test.ts` with an injected fetcher, using row shapes copied
  from treg's published examples (anyapi search, user posts, replies and single
  post) and X's own GraphQL shape (a fallback scraper):
  - field aliases, missing fields, and quoted posts;
  - text truncation at a whole character;
  - `parsePostRef` for x.com URLs, twitter.com URLs, and bare ids;
  - `sinceId` filtering, early stop, and the pinned-post exception;
  - paging up to `limit`;
  - the fallback to the routed endpoint on `unavailable` only;
  - each error status, including `route_max_cost`;
  - the timeout and the body cap;
  - Test's two calls.
- `server/routes/x-research.test.ts`: refused with no token or the bot switch
  off; the token read per call; bad input is a 400; success passes the compact
  result through; failures map to 404/502.
- `server/drivers/agents-call.test.ts`: the four handlers call the right routes
  and surface route errors.
- `server/drivers/agents-catalog-wire.test.ts`: new `+x` profiles, goldens
  regenerated, `BUDGET_BASELINE` raised by hand for those profiles only; the
  existing profiles stay byte-identical.
- `server/activity.test.ts`: the four labels.
- `electron/diagnostics.test.mjs`: the mirror list includes `OMB_TREG_TOKEN`.
- Config tests: the token is stripped from engine environments and follows a
  save.
- Request-auth test: a phone token's `PATCH /api/bots/:id` with `xResearch` is
  refused.
- Manual: an OMB2 build. Omkar pastes a real treg token, Test shows the
  balance, he turns X on for one bot, asks for this week's MausBot mentions,
  then sets an hourly routine and checks that the second run reports only new
  posts.

## To verify during the build

These need a real token:

- That `since_id:` works inside anyapi's search query. If it does not, the
  client-side filter alone still gives correct results.
- How a fully missed routed call is answered (a 200 with an empty or null
  output, or an error status), so the profile not-found path matches it.
- Whether `/auth/me` and `/orgs/{id}/balance` accept the `X-Treg-Token` header
  for a token minted by `treg login --token`.
