# Team Clouds: the `team` role and the audience rule

A **Team Cloud** is one Cloud machine several people use: the shared home of a team's bots. The Admin
(openmaus-cloud, `docs/team-cloud.md` there) makes it, invites people and signs each person's pairing. This page is the
machine's side: what the `team` role changes against a My Cloud ([cloud-pro.md](cloud-pro.md)), and the one rule that
keeps people apart on it. The bot box ([bot-box.md](bot-box.md)) is what makes that rule hold against a bot with a shell.

## What a team sees

- **Signing in.** Each person pairs from the app with a link the Admin signs for them; the machine shows the team's name
  wherever a server names itself. Owners and Admins get everything an admin session can do (Super admin and Admin in the
  app); a Member (User) uses each bot as far as it is shared with them (below, "Who can use a bot"), uses rooms and
  makes routines, and connects no app and makes no webhook.
- **Conversations.** A bot's main chat is the team's: everyone who sees the bot reads and writes it. Teammates are
  in the @ list too, and whatever is addressed to one of them reaches their inbox (below, "One inbox per person"). "New conversation"
  is yours alone: no other Member and no Admin, the Super admin included, sees it, writes in it or learns of it, in
  lists, counts, unread marks, searches, files, notifications, streams, a bot's tools or another bot. A group chat is
  seen by whoever sees it, and its unread mark is each person's own: a bot's reply there is unread for everyone until
  they read it, and one person reading it clears it for nobody else (`room-reads.json`). Every private chat says so in its header, *"Private · only you"*, and the first one on a
  device also says it as a sentence: *"Your chats in Acme are private. Only you can see them: not other members, not
  Acme's admins."* The server marks such a conversation `private: true` on the wire (`WireTask.private`). When you leave
  the team (or are removed), your private chats and everything only yours there are deleted, never handed to an admin
  (below).
- **Memory.** Each bot keeps three kinds of notes: the team's, a group chat's and a person's. A turn reads the team's notes and
  the notes of where it is, and saves into where it is. What you tell a bot privately never reaches a room or another
  person's chat; what a group chat decides never reaches your private chat. You can open, edit and delete what a bot
  remembers about you (the bot panel's What it remembers, `/api/bots/<bot>/memory/mine`); nobody else can. "About you" is yours alone: `GET`/`PUT /api/me`
  (the app's Profile on a team), read into your own conversations only.
- **Profile.** "You" is the person signed in: your own name, picture and About you (`people/<person>/profile.json` and
  `about.json`, `GET`/`PUT /api/me`), with the address of your verified sign-in, which nothing here changes. Settings →
  Profile saves yours only (an older app's `PUT /api/config` `profile` lands on the caller's own too), and `GET
  /api/config` and every config frame on your stream carry yours. Your lines, cards and reactions carry your name; a bot
  names you in your private chat, each speaker on a group chat's lines, and a routine's run its writer. config.json's one
  `profile` is nobody's on a team: it is never shown or read as anyone, and when the person whose address it names signs
  in it becomes theirs (filling only what they have not set) and is cleared. When the desktop app opens a team, the name
  and picture of that computer's own Settings → Profile fill what the person's team profile lacks (`PUT /api/me` with
  `fillEmpty: true`, the picture uploaded first as their own attachment): each field once (`GET /api/me` lists the
  `seeded` ones), never over what they set on the team and never again after they clear it there. Nothing else goes up.
  **A teammate's name and picture are visible to everyone in the team, like any team app. About you and everything
  else stay private.** Wherever the app shows a person (the Reports to picker, the owner's face on a bot's row, the Team
  map's "Who reports to whom", a card's "Asking Ada", the @ list, a "Told Bob" chip, a Needs you line from them) it shows
  their picture, or their initial when they have none; the picture is served to the team's signed-in members only
  (below), never off the team.
- **Connected apps.** The team's connections (Composio, HighLevel, MCP sign-ins, an AI key an Admin saved) belong to the
  Team Cloud and serve every member's turn through the broker. An Admin can instead make an app or an MCP server *each
  person's own* (below): then every member connects their own, and only their own chats use it. A person's
  connections from elsewhere have no way in: a share code, a moved MCP sign-in or a HighLevel connection is refused with
  *"Personal connections never enter Acme. Ask an admin to connect it for Acme."* A login from a sign-in card is saved by
  an Admin only, for the whole team.
- **Browsers.** Each private chat with a bot drives that person's own browser of the bot, each group chat the group
  chat's, and the bot's main chat the team's: separate Chrome profiles, saved sign-ins and live views, so a site one
  member signed in to in their chat never opens signed in for another member. The live view shows the browser of the
  conversation it is opened from, to whoever may read that conversation (a member's own browser to that member alone);
  with no conversation named (a phone) it is the person's own. Every Chrome runs in its own box (below).
- **Phones.** Settings → *Open on your phone* (and *Connect your phone* in the account menu) shows a code made for the
  person signed in. The phone app scans it as any `/pair#code=` link and gets that person's session: their address,
  their role, their chats, never another member's. The phone stays signed in while the person's app keeps checking in
  with the Admin (it does so while the team is open in it) and ends within the hour after the last check. Under the code,
  *Paired devices* lists the phones those codes opened as *device · member* (`GET /api/team/phones`): a member sees their
  own, the Super admin and Admins every member's. **Remove** (`DELETE /api/team/phones/<id>`, the same rule) signs that
  phone out at once and closes its open streams; the app windows the Admin signs in are not listed there.
- **Never asleep, kept across restarts.** A Team Cloud refuses the Admin's sleep request (`busy: ["team"]`) and keeps
  every member's session across a restart; a My Cloud revokes every session that is not its owner's at each boot.

## The role

`OMB_CLOUD_ROLE=team` with `OMB_CLOUD_TEAM_ID` (the Admin's id) and `OMB_CLOUD_TEAM_NAME` (1 to 80 characters), beside
the usual Cloud home contract (`OMB_CLOUD_MACHINE_ID`, `OMB_CLOUD_ADMIN_URL`, `OMB_CLOUD_BOOTSTRAP_SECRET`,
`OMB_PUBLIC_URL`). Everything else is a Cloud home: the signed routes (`/api/cloud/pairing`, `/api/cloud/health`,
`/api/cloud/power`, `/api/cloud/box`), the launcher, the box, the broker, `OMB_CLOUD_EXPORT_ONLY=1`.

What the role turns off: the personal settlement (`cloud-owner.ts`: no session is revoked at boot, no owner key, no
earlier-owner adoption), lending a Mac (nobody's Mac serves a team), the guest confinement of a My Cloud (a member's turn
runs at the bot's own level inside the box; only what came in from outside, a webhook, runs confined), and the "only the
owner" card rule (whoever started a conversation, or an Admin, answers its cards, as on a hosted workspace).

`OMB_CLOUD_TEAM_LANGUAGE` (optional, one of the app's locales: `de`, `pt-br`…) is the team's default language, set on
the Admin's Team admin → Settings. It is this server's language while its own settings set none (the app's words and the
language new bots start in); a value that isn't a locale is ignored, never refused.

## Team admin: the Admin's signed read

The Admin's Team admin pages (openmaus-cloud docs/team-cloud.md "Team admin") show a team's Super admin and Admins what
this server shares with every bot. It exists only on a Team Cloud.

- `GET /api/cloud/team/admin`, signed like `/api/cloud/health` → `{ v: 1, apps: { available, services: [{ slug, status,
  accounts: [{ id, alias, status }] }] }, mcp: [{ name, transport, host, enabled, signedIn, secrets }], keys: [{ id:
  "treg" | "voice", configured, included? }], ai: { keys: [{ id: "anthropic" | "openai" | "openrouter", configured }],
  engines: [{ id, name, authenticated, account: { email, organization, method } | null }] } }` (`cloud-team-admin.ts`).
  Names, states and the identities the providers report: never a key, a token, a header or environment value (`secrets`
  are their names), nor any part of an MCP address but its host.
- Changes are never signed calls of their own. The Admin pairs as the admin making the change (the usual signed pairing
  with their `member` claim: an `owner` or `admin` gets the admin scope) and uses that session with the routes the app
  uses: `PATCH /api/config` for a key, `/api/mcp/servers` to add, test, sign in to and remove a server,
  `/api/connectors/:slug/authorize` and `DELETE /api/connectors/:slug/accounts/:id` for apps. Every check, side effect
  and record is the app's own, and each change is that member's. A User's session is refused there as anywhere.
- A Team Cloud always keeps its admin activity (`/api/admin-activity`), even with no User signed in: it is shared by
  definition. Beside what any shared workspace records, a team bot's name, title, description, instructions and colour
  changes are recorded too. The Admin's Team admin → Activity reads it with the same session, beside the team's own record there; Usage
  reads `/api/usage` (by person, bot and model) and `/api/usage/traces` (the runs) the same way. A member's private chat
  shows there as metadata only: its usage counts and cost by person and bot, an activity row's when, bot, tool and
  outcome; never its runs' titles or a decision's words.
- For a business sign-in (Claude or ChatGPT on this server), the Admin opens this server's own pages signed in as that
  admin (a browser sign-in with the member's claim) at `/?connect=ai` (or `apps`, `mcp`, `keys`).

## Connections: the team's or each person's

Every app (a Composio toolkit) and MCP server has a scope. `team`, the default and what every connection made before this
is, is one connection an Admin makes and every turn uses. `person` is one connection per member, made by that member on
their team page in MausBot Cloud (the Admin's Cloud page calls the routes below as them).

- **Who gets a member's own connection.** Only a turn that acts for them (server/host/acting-person.ts), read from the
  harness's records, and only in a chat that is theirs alone, where nobody else reads what their connection brings back.
  A turn acts for them when their own message started it, or when it is work handed on (delegated, assigned, consulted,
  or a thread a bot opened for it) by a turn that acted for them, recorded as it is handed on (`handed-people.json`, so a
  restart keeps it). A turn stops acting for anyone once another person's words join it after it began (a line of theirs,
  queued or sent into it, or their answer to one of its cards); a routine, a webhook and a bot's own work act for nobody.
  Each step that uses one says whose ("using Ada's Gmail").
- **Work they start where others read.** Their own line in a group chat or the bot's main chat never uses their own
  connections there; the bot is told to hand that part on. When they have connected anything of their own, the work their
  request hands on opens in the receiving bot's chat with them (a thread private to them, as their own chats are: no
  other member and no admin sees it), where their own connections work. What that chat hands back to the place they
  asked in is only where the result is ("Done. The result is in Clerk's chat with Ada."), never the result: a private chat
  never reaches a room or the team (server/host/room-access.ts).
- **Apps.** A member's own apps are their own installation on the connected-apps service (their own Composio user),
  registered the first time they press Connect. Their turn gets a second bridge, `own_apps`, beside the team's
  `composio`; the relay checks every frame again: the team's bridge refuses a `person` app (and code that calls apps
  while the team's own installation still holds one), a member's bridge refuses a team app and anything outside their
  own turn. A connection card for a `person` app is never shown: the bot gets one plain line to say, *"Connect your
  Gmail here: <their page>"* (a User's team home; the Owner's and an Admin's own connections are on the team's Apps
  page); in work that acts for nobody, that the person can ask themselves, or an admin can connect it for the whole
  team on the team's Apps page. A card for a team app asked through a member's own bridge is never shown either: for
  the Owner or an Admin, the bot asks for it through the team's `composio` bridge, whose card connects it for everyone;
  a User is told who can connect it, by name (the team's Owner and Admins), never to "ask an admin" with no name. Either
  way the bot doesn't try it another way (the browser or another tool).
- **MCP servers.** Only a server reached by its address can be `person`. A `person` server's team credential is never
  attached to any turn; a turn that acts for a member gets the server with their own key (in the header the Admin's key
  used, else `Authorization: Bearer`) or their own sign-in; one not mounted is named to the bot with why and the fix. Both are pinned to the server's address: re-pointed, they aren't sent.
  Removing the server forgets every member's key and sign-in for it.
- **Storage.** `team-connection-scopes.json` (no secret, carried by backups) and `people-connections/` (0700; each
  member's installation token, keys and sign-ins, 0600), which no backup carries and no bot box binds. Nothing a route
  answers carries a key, a token or more of an address than its host.

| Route | Who | |
|---|---|---|
| `PUT /api/team/connection-scopes { kind: "app" \| "mcp", id, scope: "team" \| "person" }` | admin | `{ scopes: { apps, mcp } }`; recorded in admin activity |
| `GET /api/team/my-connections` | the member | `{ team, link, email, apps: [{ slug, name, connected, accounts }], mcp: [{ name, host, connected, how, offers }] }` |
| `POST /api/team/my-connections/apps/:slug/connect` | the member | `{ url }`, the app's own sign-in (a new tab) |
| `DELETE /api/team/my-connections/apps/:slug` | the member | |
| `POST /api/team/my-connections/mcp/:name/sign-in` | the member | `{ auth }`; it comes back to this server's `/mcp-oauth/callback` |
| `PUT /api/team/my-connections/mcp/:name/key { value, url? }` | the member | write-only; with `url`, returns 409 if the server URL changed |
| `DELETE /api/team/my-connections/mcp/:name` | the member | |

The signed read (`GET /api/cloud/team/admin`) adds `scopes: { apps, mcp }` and `people: { apps: { <slug>: [address] },
mcp: { <name>: [address] } }`: who has connected each, never with what.

## The pairing claim (contract v1)

The Admin signs the usual pairing body with two more fields:

```json
{ "label": "OpenMausBot app (Team Cloud)", "ttlSeconds": 300,
  "team": { "id": "<team id>", "name": "Acme" },
  "member": { "email": "mira@example.com", "role": "owner" | "admin" | "member" } }
```

| Claim | What the machine does |
|---|---|
| `member.role` `owner` or `admin` | scopes `admin` + `client` |
| `member.role` `member` | scope `client` |
| `member.email` | the session's address; the person's key (`personKey`) is its hash, the same on every device |
| `team.id` (optional) | must be this machine's team: `team_mismatch` otherwise |
| no `member` | `member_required` (400); a bad address or role `invalid_member` |
| a bad signature | `invalid_signature` (401), and it counts toward the pairing lockout |
| any `team` or `member` claim on a My Cloud | `not_a_team` (400): a My Cloud is one person's |

The session carries `teamRole` and `membershipAuthority: "team"`: the sign-in list never revalidates or revokes it, and
`/api/auth/session` answers `team: { id, name, role }`.

**Membership lives on the Admin.** No roster read exists, so the machine checks membership at each pairing, which the
Admin signs only for a current member. A team session therefore ends within the hour of its pairing
(`TEAM_SESSION_MAX_MS`), however much it is used, and the app pairs again; a removed member's next pairing is refused by
the Admin (404). A session is also kept only across a clean restart.

**When someone leaves.** The Admin tells the machine when a member is removed or leaves: `POST
/api/cloud/team/member-left` with `{ "email": "<address>" }`, signed with its body like the sleep request (400
`invalid_member` for a bad address; only on a Team Cloud). The machine then deletes what was that person's alone and
answers `{ ok, chats, layers, sessions, files, browsers, bots }`: every session and phone of theirs and any open code of
theirs end at once; their own MausBot is deleted as the app deletes a bot, with its chats and notes (`bots`, its chats
counted in `chats`), and should they join again they get a new one; their private chats with every bot are deleted as
the app deletes a conversation (messages, notifications, follow-ups, a running turn stopped first), with the uploaded
files only those chats used and every file they uploaded that nothing uses (a file they took off a message before
sending goes at once: `DELETE /api/attachments/<name>`, its uploader only, while nothing uses it); their memory
layers (`workspaces/<bot>--member-<person>`, their journal and search index); their "About you" and profile
(`people/<person>/`); their own connections, keys and MCP sign-ins; and their own browser of every bot and shared
profile. Nothing of it is handed to an admin. Each conversation keeps its starter in `thread-starters.json` (a hash), so a
record that still names it (a usage trace, an activity row) stays theirs and no admin reads it there. An export of their
own chats before they go is not built.

**A member's own code (their phone).** `POST /api/team/phone-pairing` (any team session, Member included) makes a pairing
code carrying the caller's `member` claim (address, role, the role's scopes) and the time the Admin last vouched for
them; on a Team Cloud `POST /api/auth/pairing` does the same for an admin session, so no team session makes a bare
code. The session it opens is a team session that ends within the hour of that check, not of the scan; each later
Admin-signed pairing of the same member in the same role moves it (`SessionRegistry.memberChecked`). An Admin-signed
pairing at another role ends every session, phone and open code of that member at the old role at once
(`SessionRegistry.revokeMember` with the new role kept): the Admin signs one as soon as the Owner changes a role, so a
demoted Admin loses admin scope then, not within the hour.

## The audience rule

Everything stored on a Team Cloud carries an audience (`server/audience.ts`):

| Audience | Who | What carries it |
|---|---|---|
| `team` | everyone who sees the bot | a bot's main chat, its own folder (`workspaces/<bot>`: MEMORY.md, memory/, skills), team files, routines nobody opened |
| `room:<id>` | whoever sees the room | the room's threads, `workspaces/<bot>--room-<id>` |
| `member:<person>` | that person only (never an Admin) | the conversations they opened (`thread-starters.json`), `workspaces/<bot>--member-<person>`, their uploads, `people/<person>/about.json` |

**A turn reads only inputs whose audience includes everyone who will see its answer, and writes only into its own
audience.** `mayRead(input, turn)` is true for the team's things and for the turn's own audience, nothing else.

| Turn | Reads | Writes into |
|---|---|---|
| Mira's private chat with Scout | Scout's setup, the team's notes, Mira's layer, Mira's About you, Mira's conversations with Scout | Mira's layer (memory_update, the memory file, the turn's log line, captured facts; About-you facts to Mira's About you) |
| A room with Mira and Ben | Scout's setup, the team's notes, the room's layer and threads | the room's layer |
| Scout's main chat | the team's notes, the team's conversations | the team's notes |

Where it is applied: visibility (`VisibleSet.thread` with each conversation's audience, for a member and an admin alike:
an admin session is a viewer with a person, `{ kind: "all", email }`, that sees every bot and room but only its own
private chats; `server/host/visibility-host.ts`). Every request names its conversations through one gate: the path
(`/api/threads/<id>`, a bot's or room's `/tasks/<id>`), `?threadId=`, and any `threadId`, `…ThreadId` or `threadIds` in
its JSON body (`server/host/team-private.ts`): another person's chat answers 404 *no such conversation*, as one that
does not exist, and so does a route that would fall back to the bot's selected conversation when that one is someone
else's. A bot sent to anyone carries only the conversations they may read; when its selected conversation is someone
else's, the main chat is named instead, without the other's messages, and its unread mark counts only what they see.
Search, SSE (live and replayed), attachments, notifications, usage traces, routine runs, the activity and decision rows
(kept as when, bot, tool and outcome, without their words), a bot's activity, synced folders and a team backup go
through the same check, a deleted private chat included. Incidents and escalations from a private chat go to its person,
never into a Chief's thread; work handed on from a private chat runs in a thread of that same person's, and nothing
from a private chat is handed into a room or posted in one; a conversation a bot opens from a shared chat is the
team's, never the last speaker's; `retry_thread`, `close_thread` and `session_search` reading a message reach only what the turn may read;
and team memory is never published from a private chat. Then the memory system prompt
(the turn's layer, plus the team's notes read-only), recall (`buildRecall.memoryIds`: the layer and the team's), recent
work, `session_search` (memory of the layer and the team's; conversations the turn may read), memory writes
(`/api/internal/memory`, `/memory/log`, the turn-outcome line, capture), "About the user", and the bot box, which puts the
turn's layer folder back read-write for that conversation's boxes only (`botBox.lend`). Member layers are sibling
folders of the bot's own, never inside it, so no other turn of that bot can read them.

The same request to one bot from two requesters is answered once only where the same people see both conversations
(`shareAnswer`, see `docs/runtime-contract.md`): two bots working for Mira get one answer, while Mira's private work
never gets the answer Ben's got, so each of them is answered on its own.

### Engine homes

The engines keep each conversation's transcript and session files in their HOME (`~/.claude/projects`,
`~/.codex/sessions`, prompt history, file snapshots). On a Team Cloud each audience has its own engine home,
`engine-homes/<key>` in the data folder, keyed like its browser: `team`, `room-<hash>` or `member-<hash>` (16 hex
characters of the room id's or person key's SHA-256). Every engine a turn starts runs with HOME set to its
conversation's home (`server/engine-homes`): the drivers' spawns know their conversation (each adapter's `sendTurn` and
keep-warm ping run inside it), and an engine folder the environment names (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`GROK_HOME`, the XDG folders, a ChatGPT plan's or a hosted model's folder) moves into that home too. Engines that share
one process between conversations (OpenCode) never share it across audiences.

In the bot box the turn's engine home is bound read-write **in place of** the server's HOME, after the data folder is
emptied: a shell in that turn finds its own audience's transcripts, and neither the server's HOME nor another audience's
home exists for it, by any path. Only the engines' sign-ins are the team's: each sign-in file (Claude's
`.credentials.json`, Codex's and Grok's `auth.json` and `config.toml`, and the other engines' named in
`engine-homes/layout.ts`) is kept in the home as a copy of the server's, and inside a box the server's own file is bound
over that copy read-write, so a token an engine refreshes there lands in the team's file (Claude Code 2.1.294 renames a
temp file over its credentials and, refused on a bind, writes in place; Codex writes in place). Outside a box an
engine writes its copy, and the next spawn in any audience takes the newest settled copy back for the team. Signing in
or out from the app still happens in the server's HOME and reaches every audience's next turn. Session resume works
within an audience: its home is the same at each turn. A member who leaves takes their engine home with them.

**The move.** The first turn after a Team Cloud starts with engine homes moves what the engines kept in the server's
HOME. A Claude Code project's session (`projects/<folder>/<session>.jsonl` and its session folder, `file-history`,
`session-env`, `todos`, `debug`) or a Codex rollout (`sessions/…/rollout-…-<id>.jsonl`, `archived_sessions`) goes to
the home of the conversation whose saved resume session id it is, or, for Claude, the conversation that alone runs in
that project's folder. What matches no conversation (a group chat's session, which the server keeps only in memory,
one of a deleted conversation, the prompt history, shell snapshots, Codex's logs) goes to the **held folder**,
`engine-homes/.held/<time>`: no route serves it, no box binds it, no backup carries it (the workspace backup leaves out
all of `engine-homes`), and it is deleted 30 days later. `engine-homes/.migrated` marks the move done.

Browsers follow the same rule (`server/browser/audience.ts`). A non-team audience adds a fixed suffix to the browser's
name, `--member-<hash>` or `--room-<hash>` (16 hex characters of the person key's or the room id's SHA-256: agent-browser
refuses a socket path over 103 bytes), to the agent-browser session, its saved state, its profile folder, the new
engine's profile key (`bot:<bot>--member-…`, `shared:<profile>--member-…`) and a temporary browser. Which suffixes exist
is kept in `browser/audiences.json`, so deleting a bot or a shared profile erases every audience's browser, after a
restart too. The live view takes `?threadId=` (the desktop's panel sends it on a team), and so do the signed-in sites
routes.

**Each Chrome in a box.** On a Team Cloud with the bot box on, the Chrome launcher agent-browser runs starts every
Chrome inside bubblewrap (`net: "shared"`, as the browser's own gate filters its traffic): the system read-only, private
`/tmp` (its HOME), the seccomp filter, and of the disk only the profile it was started on (`--user-data-dir`). A file a
turn uploads is linked into that profile's `omb-uploads/` first. The agent-browser daemon itself stays outside: it
holds the session's saved-state key and talks to the server's runtime by its own socket and pid files.

On a My Cloud and on a desktop there is one person: every audience is the team's, every layer is the bot's own folder,
every browser keeps its old name and Chrome its old launcher, every engine keeps the server's HOME, and nothing here
changes what those do.

## Who a bot reports to

Every team bot has an **owner**: the member it reports to. `reportsTo` (an email) names them; without it the bot
reports to `createdBy`, the member who created it or moved it in (a bot a Chief creates gets the Chief's owner). Bots
made before owners were recorded have none until someone picks one, and their asks go to the Admins. The sidebar shows
the owner's face at the end of each bot's row and "→ Ada" beside a department whose bots all report to Ada. The Team map's
"Who reports to whom" (also "See who reports to whom" in a department's menu) shows each person with their Chief and
the bots that report to them by department; dragging a bot onto a person changes its owner. Each face is the person's
picture from their team profile, or their initial when they have none.

| Route | Who | What |
|---|---|---|
| `GET /api/team/people` | any member | the members the Admin has paired here (`team-people.json`), each `{email, name, role, you?, pictureUrl?}` |
| `GET /api/team/people/<person>/picture?v=<version>` | the team's members | that member's picture (`<person>` is their person key). `pictureUrl` names it, and its `v` changes whenever they change it; it is revalidated on every use (`private, no-cache` with an ETag). A session that isn't a member of this team gets 403, anything off a team or not a current member's picture 404 |
| `PUT /api/bots/<id>/reports-to {email}` | an Admin, or the bot's owner handing it over | one bot's owner; `null` hands it back to its creator |
| `PUT /api/team/reports-to {botIds, email}` | an Admin | "Set owner for all bots…" on a department |
| `GET /api/needs-you` | any member | what bots ask of this person now, and the tags and passed messages waiting for them |

**Routing** (`server/ask-routing.ts`). A bot's ask is a question or approval card, a sign-in, a failure, or a routine's
result. In a member's private chat it is that member's alone: never the owner's, never an Admin's. Anywhere else (the
bot's shared chats, a group chat, a routine nobody opened) it is the owner's, or the Admins' when nobody owns the bot.
The asked person alone gets it in their Needs you (`/api/needs-you`, `/api/today`) and in their inbox (below), with the
one notification about it (live and in the feed). The card itself stays in its conversation, where everyone who sees it
may answer it, and says "Asking Ada"; the asked person may answer it too, there or from their inbox. Routing decides only
whose inbox a bot's own asks reach; who may chat with the bot is its sharing's (below).

**One Chief of Staff per person.** A crowned bot that someone owns is that person's Chief; a team has at most one per
person (crowning a second hands the role over, and moving a Chief to someone who has one is refused). Its authority is
exactly the bots that person owns, in every department: they are its team in its roster, their incidents and
escalations come to it (into a notices chat of the person's own; a notice from someone else's private chat goes to
that person instead), and it retries their threads and changes their setup. The person's private chat with it is their
inbox (below). A crowned bot nobody owns stays its department's Chief, as on any other server.

**Every bot reaches every bot.** Departments are folders, not walls. Any bot can ask, hand work to or @mention any
other bot on the team, in any department, someone's Chief included, with nothing to set up (`canReach` in
`server/peer-roster.ts`). Each bot's roster lists them all, its own department first; a Chief's lists its own team
first and everyone else as reachable. Reaching a bot gives no authority over it: supervision, incidents, escalations,
the inbox, setup changes and automations follow ownership and departments as above (`hasAuthority`, `canManage`).
Only three things narrow reach: a bot's own peers list (a person can open it again in the bot's settings, under
Permissions), archived bots, and the audience rule below (a bot shared with different people). A turn in someone's
private chat may ask any bot, and the work it hands on stays in that person's audience; it never hands work into a room
or posts in one.

On a My Cloud and on a desktop no bot has an owner: nothing is routed, and one Chief per department holds as before.
Every bot still reaches every bot there.

## Who can use a bot

Each team bot is shared like a document: what everyone in the team gets, and a level for each person added. A person's
level is the higher of the two. Admins (the Super admin included) and the bot's owner can always edit it and are never
listed.

| Level | What they can do |
|---|---|
| No access | Nothing: the bot is not listed for them, and every route naming it, its conversations, its rooms, routines and files answers 404 as for one that does not exist |
| Can view | See the bot, its main chat and the conversations shared with them (rooms, their own earlier chats), read only; open them and mark them read |
| Can chat | Also write to it, start their own conversations, answer its cards, react, stop it, write in its rooms, run its routines and make routines for it (and change or delete their own) |
| Can edit | Also change its instructions, profile and model, which of the team's connected apps and MCP servers it uses, any of its routines, its sharing, and approve a card that changes the bot itself (instructions, model, skills, team, triggers) |

Can edit never reaches what only an admin sets on any bot: what it may do on its computer (approval level, always
allow, folders), where it runs, its department, whom it answers to or directs, connecting an app or making a webhook.

- **Sharing.** `bot.access` is `{ everyone: "none" | "view" | "chat" | "edit", people: { <address>: "view" | "chat" |
  "edit" } }` (`shared/bot-access.ts`); "none" for everyone is "Only people added". It is sent only on the copy of
  someone who can edit the bot; everyone's copy carries `yourAccess`, their own level. `PUT /api/bots/<id>/access` with
  the whole value sets it (Undo puts the previous one back): someone who can edit it only, a new person must be a
  current member of the team (an older list's address or `@domain` may stay), and the owner is never stored. The bot's
  `visibility` follows in the same write (everyone when everyone may at least view it, else the owner and the people
  added), so every rule of the audience rule above that reads who sees a bot holds unchanged. A new team bot is
  Everyone · Can chat. A member's own MausBot stays theirs alone, as before.
- **Before levels.** A bot whose sharing was never set is read from its visibility, exactly as it was: everyone →
  Everyone · Can chat; admins only → Only people added (admins still edit); a list of addresses → those people · Can
  chat. Nothing is rewritten on disk; the first change in the Share dialog stores the sharing. An older app's
  visibility change on a team sets the matching sharing.
- **The owner.** Handing a bot on (`PUT /api/bots/<id>/reports-to`) keeps the previous owner at Can edit, as a document
  handed on does, and the new owner sees it.
- **Where it is enforced** (`server/host/bot-access-gate.ts`, after the visibility gate): every member request naming
  a bot, a conversation (by path, query or body), a room (needing the level on every bot in it), a routine or a run.
  Reads need Can view, everything that writes Can chat, sharing Can edit; `PATCH /api/bots/<id>` takes each level's own
  fields (`memberBotPatchViolation`), a routine needs Can edit unless its writer is changing it, a new room or routine
  needs Can chat on what it names, and a card that changes the bot needs Can edit to answer (`cardAnswerRefusal`). A
  message another app relays for a person (the guarded route's `onBehalfOf`) needs that person to be able to chat; one
  that names nobody needs everyone to be able to. The live stream sends each person their own `yourAccess` with every
  bot frame, withdraws a bot that stops being shown (`bot.deleted`, and their stream ends to start fresh) and sends one
  that becomes shown whole.
- **The app.** The bot's Share button (the bot panel in Simple, the settings header in Advanced) opens the Share
  dialog on a team; the conversation's copy and download sit at its foot. Someone who can only view a bot sees "You
  can view Payroll, not chat with it." where the composer would be (and in a room with that bot), opens its main chat
  rather than a new one of their own, and is offered no New conversation. Off a team none of this shows.

## One inbox per person

Everything addressed to a person reaches one place, their **inbox** (`server/host/person-inbox.ts`): their own private
chat with their own Chief of Staff, or with their own MausBot while they crowned none (every member gets one). It is the
chat that bot opens to for them (`WireTask.inbox`, sent to its person alone): the one their brief was in, else their
newest own chat with that bot, else a new one, "Inbox". Crowning another Chief moves it. Nothing is turned on: every
member of a team has one, and off a team none exists.

Each thing addressed to the person is one line there, `WireMessage.inbox` (`shared/inbox.ts`): who it is from (a
teammate or a bot), the bot that passed it on, and the conversation it came from, linked only when the person may read
it. The person gets **one notification** for it, from the inbox (`forPerson`, the usual live and phone path), and the
inbox is unread.

| What | Line | It answers back to |
|---|---|---|
| `message_person` ("tell Ben that…"), from any conversation | the message, `kind: "message"` | the bot that asked, in that conversation |
| @Ben in a teammate's line, anywhere (only their words travel) | the line or paragraph, `"message"` | the teammate's own inbox |
| @Ben in a bot's settled reply, where Ben can see it | the same | that bot, in that conversation |
| a question or approval routed to Ben (`ask-routing.ts`), from a shared chat, a room, a routine or work handed on | a copy of the card, `"ask"` | the card where it was asked: the copy's buttons answer it there (`answeredIn`) and the copy follows it |
| a routine's report or a failure routed to Ben | the report, `"result"` / `"notice"` | nothing |

An ask in the person's own private chat, where they are, stays only there. The Admins' asks (a bot nobody owns) are not
anyone's inbox. A member without any bot of their own gets the notification where it was written, as before.

**A teammate's question.** At Full access ("Just do it", every bot's default) a question from work the person started
and a bot handed on never reaches them unless only they can give what it asks (a sign-in or code, a payment, a secret or
an account of theirs; work a webhook or another outside event started still asks them, and so does work in their
private chat, whose question's words stay there): the bot that handed the work on answers it, and with no answer from it the bot goes on with the default it
named and says so; its card in the bot's conversation shows who picked what, waits on nobody, and still takes the
person's own answer. What only the person can do is asked for exactly, once, while the rest of the work moves on. On
"Ask me first" work handed on that needs the person asks them with a card: a decision with a few set answers through the
bot's question tool, the bot's own choices as buttons, and anything else as a card with a reply field in place of its
`NEEDS INPUT:` line (docs/runtime-contract.md). It waits however long they take. Its copy reaches their inbox with the
same buttons, and the conversation that handed the work on gets no chip about it when that conversation is the inbox
itself. A line the person types while the bot waits on its own question card answers that card, as a tap would, and so
does a reply to the card or to its copy, and an answer their Chief or another bot passes on with `coordinate_bots`
(`answers`, the question's assignment id). A question whose work ended, or that the bot replaced with a newer one, closes,
and its copy, Needs you and the overview follow; a restart posts nothing again.

**Answering is replying.** A reply to a line (the chat's Reply) goes back as the table says, and the inbox's bot takes no
turn for it; the line records the answer and a "Told Cleo" chip follows it. A bot that asked carries on: its
conversation gets a line from the inbox's bot, "Ben replied to your message ("…"): …" (`relay.kind: "reply"`), which
starts its turn or waits behind the running one. Writing to the Chief in the inbox instead ("tell Cleo yes") works
too: its turns there are told what waits on the person, and `message_person` to a line's sender answers that line. A 👍
or 👎 on a line answers it the same way, with that emoji.

**What waits on the person** is read from where it was asked, each time. An ask waits while the card that asked is open
in its conversation: once it is answered there, from the inbox's copy (either respond route), by a reaction or on a
call, or closed (an approval whose turn ended or was stopped, a question the person closed), it no longer waits, and the
copy follows the card. A question its turn left open still waits for a late answer; once its conversation is deleted,
the copy is closed. A line that wants an answer waits until the person answers it, from the inbox or with a line of
their own in the conversation it came from. The inbox's task carries the asks that wait (`WireTask.openAsks`, sent again
whenever one is asked or settled), which the app shows on the person's own row under People and adds to its unread
count: the browser tab's title and the app's icon.

**The inbox's list and its card.** `GET /api/inbox` lists the session's own person's inbox (`InboxView`,
`shared/inbox.ts`), newest first, each line in one tab: **Needs you** while it waits on them (an ask, by the rule above;
their count is the badge), **For your info** for news until they answer it or mark it done, and **Done** once it is
settled or marked done. `POST /api/inbox/<line>/done` marks news done (an open ask refuses, 409: only its answer settles
it) and `POST /api/inbox/<line>/read` marks one line read; each answers with the list as it is now. The app shows the
list in the right panel, opened from the card, the badge or the person's own row under People: dense rows with each
line's quick answers, a reading view with the reply, and a sheet at phone width. Answering from a row answers the copy's
card or replies to the line, through the same routes as in the chat. In the inbox conversation one card sits under the
newest line that needed the person (`InboxView.anchor`) and updates in place. The inbox's task carries
`inboxChangedAt`, which moves whenever the list changes; a client showing the list reads it again then.

**The representative.** When a message asks something a fact the person already shares with the team answers, their
inbox's bot answers it for them (`server/host/representative.ts`); the answer goes back like a reply, as "Ben's
assistant answered …" (`relay.kind: "assistant"`), and the line shows the question, the answer and that a reply corrects
it, with the one notification saying so. What it reads is built by the server, never chosen by a model:

- **Busy times** from the person's own Google Calendar connection, when Google Calendar is each person's own on the team
  and they connected theirs (`person-calendar.ts`): start and end only, never a title, place, description or guest. It
  is the one use of a member's own connection outside their own turn, and it reads nothing else of it.
- **Shared notes**: the team layer (`workspaces/<bot>`) of the inbox's bot and the bots the person owns that everyone on
  the team sees; never a member layer, a room's, About you or a private chat.
- **Work status**: those bots' status and the titles of their shared conversations that are working.

It has **no tools**: one text call on its bot's engine (`SideJob` `"representative"`, `generateText` only, never an agent
process). Its answer must be JSON `{"answer"}` or `{"wait": true}`; anything else waits. Code holds back what only the
person can say, before any model call: anything not a question, and a question that decides, approves, agrees, promises,
commits, books, sends or shares, reaches outside the team, or asks about something private (English and German words);
and after it, an answer that speaks for the person's will ("Ben will…", "approved"). Asks and approvals never reach it,
nor tags of the person in a teammate's words that are not a question.

**Refused, in words a bot repeats:** someone who left ("Carl has left Acme…"), nobody of that name (the people are
listed), two of that name, the person the bot is already talking with, a person who cannot use this bot, someone with no
inbox here, and more than 10 passes an hour from one conversation (answers from an inbox included).

**People.** The composer's @ list offers the teammates after the bots, with their picture and a "Person" tag; the
sidebar lists the team's people with their pictures: your own row opens your inbox, a teammate's puts their @name in
the composer on screen. Each person is tagged by their whole name, and by their first name when no other teammate shares
it (`shared/person-mention.ts`). A tag a bot shares is the person's: "@Ben" reaches Ben even with a bot called Ben, and
that bot is not told it was named; only a longer bot name ("@Ben Bot") reaches a bot. A bot made or renamed with a
person's name says so once in its own chat, and the Chief's `create_bot` result warns (`server/host/bot-name-clash.ts`).
Deleting a Chief of Staff offers to archive it instead, which keeps its chats. A bot's turn is told the team's people (names and admin roles; not the person it talks
with), that `message_person` reaches their inbox, and that a tag already did. Needs you lists the inbox's messages the
person has not opened and that still wait (`kind: "message"`); the app opens the inbox on the person's first arrival of
the day when something waits there. The state is ids, names and short excerpts, in `person-inbox.json`; a member who
leaves takes their inbox with them.

On a My Cloud and on a desktop there are no team people: the @ list shows bots, `@you` and the profile name tag the one
person as before, and `message_person` and the inbox do not exist.

## What is not closed here

- **Saved logins per member.** A login saved from a sign-in card is the team's (an Admin saves it, for every bot in the
  team); per-member saved logins are not built. Sign-ins a member makes in their own browser stay in it (above).
- **The new browser engine and temporary browsers in a box.** The new engine (`browserEngine.engine: "chrome"`, off by
  default) starts Chrome itself over a pipe and is not boxed; a temporary browser is boxed, but a file a turn uploads
  into it is not reachable from its box.
- **Per-member engine sign-ins.** Every audience's engine signs in as the team (its key through the broker, or the
  team's sign-in files in each engine home, above); a member cannot sign an engine in as themselves, by design.
- **A roster read from the Admin.** Without the Admin's `member-left` request (above), removal takes effect within the
  hour, and nothing is deleted.
- **Engine homes without a box, and engines outside the list.** Without the bot box (bubblewrap refused, or switched
  off) a shell reaches every file of the server's user, engine homes included; only the box keeps them apart. An engine
  whose sign-in file is not named in `engine-homes/layout.ts` starts signed out in every audience's home. Engines
  installed into the server's HOME by hand are not reachable from a team turn's box; the image's are.
- **An engine that replaces its sign-in file by renaming.** Inside a box the rename is refused (the team's file is bound
  there); an engine that does not then write in place keeps a refreshed token for that process only.
- **What a bot keeps per bot, not per audience.** Its data sheet, the skills it stages and its own profile are the bot's
  (the team's), whichever chat wrote them; so are a routine's definition and schedule (its runs and results are the
  conversation's). The Owner's whole-machine export (`OMB_CLOUD_EXPORT_ONLY`, the workspace backup) still carries every
  member's private chats.
- **Own apps with the team's own Composio project.** A member's own apps always use OpenMausBot's connected-apps
  service, even when the team connected a Composio project key of its own; an app that needs the project's own auth
  config can't be connected by each person.
