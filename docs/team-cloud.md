# Team Clouds: the `team` role and the audience rule

A **Team Cloud** is one Cloud machine several people use: the shared home of a team's bots. The Admin
(openmaus-cloud, `docs/team-cloud.md` there) makes it, invites people and signs each person's pairing. This page is the
machine's side: what the `team` role changes against a My Cloud ([cloud-pro.md](cloud-pro.md)), and the one rule that
keeps people apart on it. The bot box ([bot-box.md](bot-box.md)) is what makes that rule hold against a bot with a shell.

## What a team sees

- **Signing in.** Each person pairs from the app with a link the Admin signs for them; the machine shows the team's name
  wherever a server names itself. Owners and Admins get everything an admin session can do (Super admin and Admin in the
  app); a Member (User) chats with the team's bots, uses rooms and makes routines, and changes no bot's setup, connects
  no app and makes no webhook.
- **Conversations.** A bot's main chat is the team's: everyone who sees the bot reads and writes it. "New conversation"
  is yours alone: no other Member and no Admin, the Super admin included, sees it, writes in it or learns of it, in
  lists, counts, unread marks, searches, files, notifications, streams, a bot's tools or another bot. A group chat is
  seen by whoever sees it. Every private chat says so in its header, *"Private · only you"*, and the first one on a
  device also says it as a sentence: *"Your chats in Acme are private. Only you can see them: not other members, not
  Acme's admins."* The server marks such a conversation `private: true` on the wire (`WireTask.private`). When you leave
  the team (or are removed), your private chats and everything only yours there are deleted, never handed to an admin
  (below).
- **Memory.** Each bot keeps three kinds of notes: the team's, a group chat's and a person's. A turn reads the team's notes and
  the notes of where it is, and saves into where it is. What you tell a bot privately never reaches a room or another
  person's chat; what a group chat decides never reaches your private chat. "About you" is yours alone: `GET`/`PUT /api/me`
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
- **Connected apps.** The team's connections (Composio, HighLevel, MCP sign-ins, an AI key an Admin saved) belong to the
  Team Cloud and serve every member's turn through the broker. An Admin can instead make an app or an MCP server *each
  person's own* (below): then every member connects their own, and only their own private chats use it. A person's
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
  definition. The Admin's Team admin → Activity reads it with the same session, beside the team's own record there; Usage
  reads `/api/usage` (by person, bot and model) and `/api/usage/traces` (the runs) the same way. A member's private chat
  shows there as metadata only: its usage counts and cost by person and bot, an activity row's when, bot, tool and
  outcome; never its runs' titles or a decision's words.
- For a business sign-in (Claude or ChatGPT on this server), the Admin opens this server's own pages signed in as that
  admin (a browser sign-in with the member's claim) at `/?connect=ai` (or `apps`, `mcp`, `keys`).

## Connections: the team's or each person's

Every app (a Composio toolkit) and MCP server has a scope. `team`, the default and what every connection made before this
is, is one connection an Admin makes and every turn uses. `person` is one connection per member, made by that member on
their team page in MausBot Cloud (the Admin's Cloud page calls the routes below as them).

- **Who gets a member's own connection.** Only a turn in that member's private chat (`member:<person>`) that their own
  message started (the request proven for that turn, as lent computers use). Never a group chat, the bot's main chat,
  another member's chat (no Admin can write in theirs), a routine, a webhook, or work handed on from another conversation.
- **Apps.** A member's own apps are their own installation on the connected-apps service (their own Composio user),
  registered the first time they press Connect. Their turn gets a second bridge, `own_apps`, beside the team's
  `composio`; the relay checks every frame again: the team's bridge refuses a `person` app (and code that calls apps
  while the team's own installation still holds one), a member's bridge refuses a team app and anything outside their
  own turn. A connection card for a `person` app is never shown: the bot gets one plain line to say, *"Connect your
  Gmail here: <their team page>"*, or that it works only in each person's private chat.
- **MCP servers.** Only a server reached by its address can be `person`. A `person` server's team credential is never
  attached to any turn; a member's own turn gets the server with their own key (in the header the Admin's key used, else
  `Authorization: Bearer`) or their own sign-in. Both are pinned to the server's address: re-pointed, they aren't sent.
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
| `PUT /api/team/my-connections/mcp/:name/key { value }` | the member | write-only |
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
answers `{ ok, chats, layers, sessions, files, browsers }`: every session and phone of theirs and any open code of
theirs end at once; their private chats with every bot are deleted as the app deletes a conversation (messages,
notifications, follow-ups, a running turn stopped first), with the uploaded files only those chats used; their memory
layers (`workspaces/<bot>--member-<person>`, their journal and search index); their "About you" and profile
(`people/<person>/`); their own connections, keys and MCP sign-ins; and their own browser of every bot and shared
profile. Nothing of it is handed to an admin. Each conversation keeps its starter in `thread-starters.json` (a hash), so a
record that still names it (a usage trace, an activity row) stays theirs and no admin reads it there. An export of their
own chats before they go is not built.

**A member's own code (their phone).** `POST /api/team/phone-pairing` (any team session, Member included) makes a pairing
code carrying the caller's `member` claim (address, role, the role's scopes) and the time the Admin last vouched for
them; on a Team Cloud `POST /api/auth/pairing` does the same for an admin session, so no team session makes a bare
code. The session it opens is a team session that ends within the hour of that check, not of the scan; each later
Admin-signed pairing of the same member in the same role moves it (`SessionRegistry.memberChecked`). A role change
leaves it to end; a removed member's phone signs out within the hour.

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
team's, never the last speaker's; `retry_thread`, `close_thread` and `session_read` reach only what the turn may read;
and team memory is never published from a private chat. Then the memory system prompt
(the turn's layer, plus the team's notes read-only), recall (`buildRecall.memoryIds`: the layer and the team's), recent
work, `session_search` (memory of the layer and the team's; conversations the turn may read), memory writes
(`/api/internal/memory`, `/memory/log`, the turn-outcome line, capture), "About the user", and the bot box, which puts the
turn's layer folder back read-write for that conversation's boxes only (`botBox.lend`). Member layers are sibling
folders of the bot's own, never inside it, so no other turn of that bot can read them.

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
the bots that report to them by department; dragging a bot onto a person changes its owner.

| Route | Who | What |
|---|---|---|
| `GET /api/team/people` | any member | the members the Admin has paired here (`team-people.json`), each `{email, name, role, you?}` |
| `PUT /api/bots/<id>/reports-to {email}` | an Admin, or the bot's owner handing it over | one bot's owner; `null` hands it back to its creator |
| `PUT /api/team/reports-to {botIds, email}` | an Admin | "Set owner for all bots…" on a department |
| `GET /api/needs-you` | any member | what bots ask of this person now |

**Routing** (`server/ask-routing.ts`). A bot's ask is a question or approval card, a sign-in, a failure, or a routine's
result. In a member's private chat it is that member's alone: never the owner's, never an Admin's. Anywhere else (the
bot's shared chats, a group chat, a routine nobody opened) it is the owner's, or the Admins' when nobody owns the bot.
The asked person alone gets it in their Needs you (`/api/needs-you`, `/api/today`), in their notifications (live and in
the feed) and in their brief. The card itself stays in its conversation, where everyone who sees it may answer it, and
says "Asking Ada". Everyone can still chat with every shared bot: routing decides only whose inbox a bot's own asks reach.

**One Chief of Staff per person.** A crowned bot that someone owns is that person's Chief; a team has at most one per
person (crowning a second hands the role over, and moving a Chief to someone who has one is refused). Its authority is
exactly the bots that person owns, in every department: they are its team in its roster, their incidents and
escalations come to it (into a notices chat of the person's own; a notice from someone else's private chat goes to
that person instead), and it retries their threads and changes their setup. Each person with a Chief gets a brief of
their own (`server/host/team-briefs.ts`): one card a day in their private chat with their Chief listing their Needs you
and the runs routed to them, opened on their first arrival of the day. Without a Chief, the same asks wait in their
Needs you. A crowned bot nobody owns stays its department's Chief, as on any other server.

**Every bot reaches every bot.** Departments are folders, not walls. Any bot can ask, hand work to or @mention any
other bot on the team, in any department, someone's Chief included, with nothing to set up (`canReach` in
`server/peer-roster.ts`). Each bot's roster lists them all, its own department first; a Chief's lists its own team
first and everyone else as reachable. Reaching a bot gives no authority over it: supervision, incidents, escalations,
the brief, setup changes and automations follow ownership and departments as above (`hasAuthority`, `canManage`).
Only three things narrow reach: a bot's own peers list (a person can open it again in the bot's settings, under
Permissions), archived bots, and the audience rule below (a bot shared with different people). A turn in someone's
private chat may ask any bot, and the work it hands on stays in that person's audience; it never hands work into a room
or posts in one.

On a My Cloud and on a desktop no bot has an owner: nothing is routed, and one Chief per department holds as before.
Every bot still reaches every bot there.

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
