# Slack for Team Clouds: the Team Cloud's side

People in a company's Slack write `@MausBot` in a channel, or message it directly, and the team's bots answer there. One
MausBot Slack app is installed per company. Slack's events arrive at the Admin (openmaus-cloud, `docs/team-slack.md`
there), which works out the team member who wrote and hands each message to that team's Cloud **with a session it opened
for that member**. This page is the Cloud's side: three routes the Admin calls, and one signed report back. The Slack bot
token never reaches this machine, and this machine never talks to Slack.

A Team Cloud (`OMB_CLOUD_ROLE=team`, [team-cloud.md](team-cloud.md)) has all of it. A My Cloud, one person's own
(`OMB_CLOUD_ROLE=home`), has the same routes and reports for its owner: see
[On a My Cloud](#on-a-my-cloud-one-persons-own) for what differs. Everywhere else (the desktop app, a self-hosted
server) every route below answers 404 with no `code`, and nothing is reported anywhere. Which plans may connect Slack
is the Admin's to decide: the app checks no plan.

## A Slack message is the member's own request

The Admin opens the session through the signed pairing with the member's claim (label `Slack (MausBot Cloud)`), exactly
as each person's app is paired. So the request is that member's, at their role, and every check is the app's own:

- The line is sent the way their composer sends it (`acceptDirectSend`, `server/host/team-slack-host.ts`): their name
  on it, their person key as its sender, `[From Priya (person) · message · their own request]` where several people
  write. It is never the relayed, information-only kind (`onBehalfOf` on the guarded route), which acts for nobody.
- Their level on the bot decides ([team-cloud.md](team-cloud.md#who-can-use-a-bot)). A bot they can't chat with (No
  access, Can view, or someone else's own MausBot) answers exactly as an id no bot has.
- They own the run ([team-cloud.md](team-cloud.md#whoever-asked-owns-the-run)): in a shared conversation someone
  else's line waits its turn, and only they, or an Owner or Admin, stop it.
- A line written while the conversation's bot works waits in the queue, as a message sent with "queue" does in the
  app, and runs after as its own turn; it is never steered into the running turn. Lines of one person that waited
  together are answered by one turn, as in the app: the last is reported with the reply, the earlier ones as completed
  with no text.
- A reply in Slack is a new line. It never answers a card: approvals and questions are answered in MausBot.

## The audience is the Cloud's to enforce

The request names an audience; the Cloud checks it against the conversation and never takes the Admin's word further.

| `audience` | From | The conversation |
|---|---|---|
| `team` | a Slack channel thread | A conversation the member opens and shares with the team at once: audience `team`, on the Team side for everyone who sees the bot. Its turns read the bot's team notes and the team's connected apps only, never the member's private layer, About you, own connections or own secrets. |
| `member` | a Slack direct message | The member's private chat with that bot, `member:<person>`: theirs alone, as any conversation they open in the app. No other member and no admin reads it. |

- A bot private to its owner, and a member's own MausBot, is refused for the `team` audience (`bot_private`): nobody
  else could read the conversation, so it would not be a shared one.
- `conversationId` continues a conversation only when the member reads it, can chat with its bot, and its audience is
  the one the request names. A channel's message never lands in a private chat, a direct message never in a shared
  conversation, and nobody's direct message in someone else's: each answers `no_such_conversation`, as an id that does
  not exist.
- A shared conversation started from Slack is like one its member shared from the app: it stays the team's when they
  leave. Their direct-message conversations are their private chats, and go with them
  ([team-cloud.md](team-cloud.md#the-pairing-claim-contract-v1)); what this machine kept of their Slack messages goes too.

## Where it came from

A conversation started from Slack is named for it, in the language of the person it is for: *"Slack #sales: What ships
on Friday?"* for a channel whose name the Admin sent (`slack.channelName`, optional), *"Slack channel: …"* without one,
*"Slack DM: …"* for a direct message. It is an ordinary title: its person can rename it. It is listed under Just me or
Team by the same answer as every conversation.

A channel's conversation is also recorded as from Slack where its sharing is (`conversation-shares.json`, `from:
"slack"`). It is never the chat its bot opens to: the bot's shared chat stays the shared chat, however often Slack
threads are written in after it.

## On a My Cloud, one person's own

The Admin opens the session through the same signed pairing with no member's claim, so it is the owner's own session,
as their app's is. The three routes, their answers, the idempotent `id`, the queue, Stop and the signed reports are the
ones on this page. What differs, because there is one person and no team:

- **Who asks.** The owner: a session with full access, whichever one the Admin opened (a new session per message is the
  same person). Any other session (a guest's) answers `404 not_a_member`.
- **Both audiences are the owner's ordinary conversation.** `team` and `member` each open a conversation as the owner
  opens one in the app, and the line is their own request through the same `acceptDirectSend`. Nothing is shared
  (`conversation-shares.json` is a Team Cloud's), no audience is compared, and `conversationId` continues any
  conversation the owner can write in, whichever audience the request names. There is no `bot_private`.
- **Bots.** `GET /api/slack/team/bots` lists every bot, each `shared: true`: all are the owner's, in a channel as in a
  direct message. `{ default: true }` is the Cloud's MausBot, else the first bot.
- **Where it came from.** The titles are the same. A conversation a channel's message opened is still never the chat
  its bot opens to; with no sharing to record it in, its id is kept in `team-slack-messages.json` (`channels`), after
  its messages are dropped. A direct message's conversation is as any the owner opens, so the one they last wrote in
  is the chat the bot opens to.
- **Nobody leaves.** Nothing is forgotten for a person; the record keeps its week, month and 2,000.

## The routes

Each takes the member's session, as a bearer. `server/routes/team-slack.ts`; the wire shapes are in
`server/team-slack.ts`.

- `GET /api/slack/team/bots` → `{ "bots": [{ "id", "name", "shared" }] }`: the bots this member can chat with.
  `shared` is false for a bot only its owner uses and for their own MausBot. There is no `avatarUrl`: a bot's picture
  is served to signed-in members only (`/api/attachments/…`), so there is no address Slack could fetch.
- `POST /api/slack/team/messages` with `{ v: 1, id, audience, bot, conversationId, text, slack }`. `id` is the
  idempotency key: the same id again answers as the first did and starts nothing. `bot` is `{ id }`, `{ name }` (among
  the bots the member can chat with, ignoring case) or `{ default: true }` (their own MausBot, else the first bot they
  can chat with). It answers `202 { accepted: true, conversationId, bot: { id, name }, openUrl }`; `openUrl` is this
  Cloud's own address with `?thread=…&bot=…`, which the web app opens to that conversation.
- `POST /api/slack/team/messages/<id>/stop`: Stop, pressed in Slack by this member. `200 { stopped }`, `403` when it is
  not theirs to stop (the run goes on), `404` for an id this Cloud never took.

| Answer | When |
|---|---|
| `404 { code: "no_such_bot" }` | No such bot, or one this member can't chat with: the same body for both |
| `403 { code: "bot_private" }` | The `team` audience and a bot private to its owner |
| `409 { code: "no_such_conversation" }` | `conversationId` names nothing this member may continue with this audience |
| `409`, `423`, `429`, `5xx` with the app's own `code` | The send was refused for now, in the app's words (`no_ai`, `spend_cap`, …): the Admin tries again |
| `422` with the app's own `code` | The send was refused for good (a team rule, a typed stop that is not theirs) |
| `400 { code: "bad_request" }` | Not the contract's message |
| `403 { code: "not_yours" }` | The id is one another member's message already has |
| `404 { code: "not_a_member" }` | The session carries no member's claim |

## Reporting back

`POST <Admin>/api/cloud/machines/slack`, signed with the bootstrap secret in a context of its own
(`teamSlackSignature`, `omb-team-slack-v1`), like the roster check: `{ v: 1, id, status, conversationId, bot, openUrl }`
with `text` on `completed`, `waiting` on `waiting` and `error` on `failed`.

What a message's run is doing is read from the conversation's own records each time they change, never polled and
never taken from a model's words (`teamSlackPhase`): the request's own marks (`requestPending`, `requestCancelled`),
the cards after it, and whether the conversation works.

| `status` | When |
|---|---|
| `running` | The message was taken; again when a card is answered, and every 10 minutes while it works |
| `waiting` | A card after the request waits on a person: `approval`, or `question` for a question, a sign-in, a password or an app to connect. Once per wait |
| `completed` | The request settled. `text` is the turn's final reply, as Markdown |
| `failed` | The run ended without an answer, the next request began before this one settled, or the server restarted under it. `error` is always `failed` |
| `stopped` | Its request was stopped (from Slack or in the app), its waiting line was removed, or its conversation was deleted |

A final report, and a `waiting`, is sent again (5 s, 15 s, a minute, then every 5 minutes, for 6 hours) until the Admin
answers; a `running` nobody answered is not. `{ done: true }` and a 404 end the reports for that message. The `stop`
the Admin may put in its answer is not read: only a member's own session stops a run.

`team-slack-messages.json` (0600) keeps each message's id, its person's key, bot, conversation, audience and state: a
week after it is over, a month at most, 2,000 at most. Never the words, the channel, the Slack user or an address. On
a My Cloud it also keeps the ids of the conversations a channel opened (`channels`, 2,000 at most). It is left out of
a workspace export.

## Cards

A card is asked where it always is. In a shared conversation it is in the conversation, where whoever asked, the bot's
owner or an admin answers it, and a copy reaches the inbox of the bot's owner
([team-cloud.md](team-cloud.md#one-inbox-per-person)); in a direct message's conversation it stays there, the member's
own. Either way the report is `waiting` and the Admin's link opens the conversation. A question a finished turn left
open is part of its reply: the report is `completed`.

## Not in this version

A picture for Slack (no public address exists), partial text for streaming, files, a reply in Slack answering a card,
and telling `model` and `limit` apart in a `failed`. A card asked by another bot the work was handed to waits in its
person's inbox, and Slack keeps showing the run as working.

See [Verifying Slack for Team Clouds](verification/team-slack.md).
