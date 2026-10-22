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
  is yours: you and the Admins see it, other Members never do, in lists, searches, files or streams. A group chat is seen
  by whoever sees it. Every private chat says so in its header, *"Private · admins can see"*, and the first one on a
  device also says it as a sentence: *"Chats in Acme are private from other members. Acme's admins can see them."* The
  server marks such a conversation `private: true` on the wire (`WireTask.private`).
- **Memory.** Each bot keeps three kinds of notes: the team's, a group chat's and a person's. A turn reads the team's notes and
  the notes of where it is, and saves into where it is. What you tell a bot privately never reaches a room or another
  person's chat; what a group chat decides never reaches your private chat. "About you" is yours alone: `GET`/`PUT /api/me`
  (the app's Profile on a team), read into your own conversations only.
- **Connected apps.** The team's connections (Composio, HighLevel, MCP sign-ins, an AI key an Admin saved) belong to the
  Team Cloud and serve every member's turn through the broker. A person's own connections have no way in: a share code,
  a moved MCP sign-in or a HighLevel connection is refused with *"Personal connections never enter Acme. Ask an admin to
  connect it for Acme."* A login from a sign-in card is saved by an Admin only, for the whole team.
- **Browsers.** Each private chat with a bot drives that person's own browser of the bot, each group chat the group
  chat's, and the bot's main chat the team's: separate Chrome profiles, saved sign-ins and live views, so a site one
  member signed in to in their chat never opens signed in for another member. The live view shows the browser of the
  conversation it is opened from, to whoever may read that conversation (an Admin reading a member's chat sees that
  member's browser there); with no conversation named (a phone) it is the person's own. Every Chrome runs in its own
  box (below).
- **Phones.** Settings → *Open on your phone* (and *Connect your phone* in the account menu) shows a code made for the
  person signed in. The phone app scans it as any `/pair#code=` link and gets that person's session: their address,
  their role, their chats, never another member's. The phone stays signed in while the person's app keeps checking in
  with the Admin (it does so while the team is open in it) and ends within the hour after the last check.
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

**Membership lives on the Admin.** Nothing is pushed to the machine and no roster read exists, so the machine checks
membership the one way it can: at each pairing, which the Admin signs only for a current member. A team session
therefore ends within the hour of its pairing (`TEAM_SESSION_MAX_MS`), however much it is used, and the app pairs
again; a removed member's next pairing is refused by the Admin (404), so they are out within the hour. A session is also
kept only across a clean restart. A signed roster read on the Admin would make this immediate; until then this is the
truthful mechanism.

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
| `member:<person>` | that person and the Admins | the conversations they opened (`thread-starters.json`), `workspaces/<bot>--member-<person>`, their uploads, `people/<person>/about.json` |

**A turn reads only inputs whose audience includes everyone who will see its answer, and writes only into its own
audience.** `mayRead(input, turn)` is true for the team's things and for the turn's own audience, nothing else.

| Turn | Reads | Writes into |
|---|---|---|
| Mira's private chat with Scout | Scout's setup, the team's notes, Mira's layer, Mira's About you, Mira's conversations with Scout | Mira's layer (memory_update, the memory file, the turn's log line, captured facts; About-you facts to Mira's About you) |
| A room with Mira and Ben | Scout's setup, the team's notes, the room's layer and threads | the room's layer |
| Scout's main chat | the team's notes, the team's conversations | the team's notes |

Where it is applied: visibility (`VisibleSet.thread` with each conversation's audience; a member's bot list carries only
their conversations; search, SSE and attachments go through the same check), the memory system prompt
(the turn's layer, plus the team's notes read-only), recall (`buildRecall.memoryIds`: the layer and the team's), recent
work, `session_search` (memory of the layer and the team's; conversations the turn may read), memory writes
(`/api/internal/memory`, `/memory/log`, the turn-outcome line, capture), "About the user", and the bot box, which puts the
turn's layer folder back read-write for that conversation's boxes only (`botBox.lend`). Member layers are sibling
folders of the bot's own, never inside it, so no other turn of that bot can read them.

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
every browser keeps its old name and Chrome its old launcher, and nothing here changes what those do.

## What is not closed here

- **Saved logins per member.** A login saved from a sign-in card is the team's (an Admin saves it, for every bot in the
  team); per-member saved logins are not built. Sign-ins a member makes in their own browser stay in it (above).
- **The new browser engine and temporary browsers in a box.** The new engine (`browserEngine.engine: "chrome"`, off by
  default) starts Chrome itself over a pipe and is not boxed; a temporary browser is boxed, but a file a turn uploads
  into it is not reachable from its box.
- **Per-member engine state.** A Team Cloud's engines use the team's key through the broker, so the engine's config dir
  (`~/.claude`, `~/.codex`) holds no member's login; it is the team's, by design.
- **A roster read from the Admin.** Removal takes effect within the hour (above), not at once.
