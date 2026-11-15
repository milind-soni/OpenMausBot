# Verifying Slack for Team Clouds

Read [the verification entry point](README.md) first. What this is and what each route answers is in
[Slack for Team Clouds: the Team Cloud's side](../team-slack.md).

Nothing here reaches Slack or the real Admin. The Admin's part is played by the test: it pairs each member with the
Admin's signed claim (label "Slack (MausBot Cloud)"), calls the three routes with that session, and runs a stand-in
Admin that takes the Cloud's signed reports and judges each as the real one does (machine, clock, nonce, the signature in
Slack's own context with the bootstrap secret, and whether the message is this team's).

```sh
pnpm exec vitest run server/team-slack.test.ts
pnpm exec vitest run server/cloud-team-slack.e2e.test.ts
pnpm exec vitest run server/cloud-personal-slack.e2e.test.ts
```

`server/team-slack.test.ts` holds the parts with no server: the signature against the value the Admin's own function
gives, the message's shape, what a conversation's records say of a run (`teamSlackPhase` in
`server/host/team-slack-host.ts`: waiting in the queue, working, an open approval or question, settled with its final
reply, stopped, failed when the next request began first, a line answered together with a later one), the record of
messages across a restart and when someone leaves, which conversations a channel opened on a My Cloud (kept after
their messages are dropped, and never written by a Team Cloud), and how each answer of the Admin's is read.

`server/cloud-team-slack.e2e.test.ts` launches a Team Cloud (`scripts/testing/cloud-send-fixture.ts`) with an Owner, an
Admin and two Users, the synthetic Claude CLI, and five bots: one everyone can chat with, one a User owns that asks
before it acts, one only its owner uses, one everyone can only view, and one a User made for themselves. It proves:

- **A channel message** (`POST /api/slack/team/messages`, `audience: "team"`) is its writer's own line in a new
  conversation shared with the team: `202` with the conversation, the bot and an https link; the reports are `running`
  then `completed` with the reply; every other member and the Owner are sent the conversation, shared and not private,
  titled "Slack #sales: …"; the line carries its writer's name; and the engine's prompt says *their own request*, with
  nothing relayed or information only.
- **The same id again** answers as the first did, while the run works and after it ended: one line, one reply, one
  conversation, one `completed`. Another member presenting that id gets 403.
- **A thread continues** by `conversationId`, for its writer and for another member who writes next, each line under
  its own name; with the other audience, or an id that names nothing, it answers `409 no_such_conversation`.
- **A direct message** (`audience: "member"`, the bot named with other capitals) is a private chat titled "Slack DM:
  …": its member reads it, and the other User, the Owner and the Admin get 404 reading it, are not sent it, and get 404
  writing in it. A channel's message, another User's direct message and the Owner's can't be put into it.
- **A final report the Admin did not take** (a 503) is sent again until it does, once.
- **Which bot**: `GET /api/slack/team/bots` lists the bots the member can chat with, each `shared` or not and none with
  a picture, never one they can't chat with; the Owner's list has the bot only its owner uses and not the User's own
  MausBot. `{ default: true }` is the member's own MausBot; `{ name }` ignores case.
- **Private and unreachable bots**: a bot only its owner uses, a User's own bot and their MausBot answer `403
  bot_private` for a channel. A bot the member can't see, one they can only view and a name nobody has all answer
  exactly what an id no bot has answers, for both audiences, and no conversation is made.
- **The audience holds**: with a marker in the member's About you and another in their private notes for the bot, a
  direct message's turn is given both, and a channel's turn (a new conversation and a continued one) is given neither,
  nor the path of their private layer.
- **An approval** asked through the bot's permission socket is reported `waiting` with `approval`, once; the card is in
  the conversation and in the member's inbox under Needs you (`GET /api/inbox`); answered in MausBot, the reports go on
  `running` then `completed`.
- **Stop** (`POST /api/slack/team/messages/<id>/stop`): another User gets 403 in the app's words and the run goes on;
  an id never taken is 404; its writer's Stop ends it, the report is `stopped`, and the conversation says who stopped.
- **Every report** verifies in Slack's context with the bootstrap secret and under no other context of this Cloud's
  (the roster check's, the Admin's own request signature); the stand-in refuses the roster context and another secret.
  What the Cloud keeps (`team-slack-messages.json`) holds no word of a message or an answer, no channel, no Slack user
  and no address.
- **When the member leaves** (`POST /api/cloud/team/member-left`), their direct message's conversation and private
  layer are gone, for them too when they join again; what the Cloud kept of their Slack messages is gone; the channel's
  conversation stays.
- **Off a Cloud**, on a desktop's own server, all three routes answer 404 with no code.

Their own connections and saved secrets are not driven here: a channel's conversation has the `team` audience, and
`server/cloud-team-per-person.e2e.test.ts` and `server/cloud-team-member-secrets.e2e.test.ts` prove what a conversation
of that audience is given.

## On a My Cloud

`server/cloud-personal-slack.e2e.test.ts` launches a My Cloud (`scripts/testing/cloud-send-fixture.ts`, no team) with
its MausBot and one more bot, the synthetic Claude CLI, and the same stand-in Admin. The Admin's session is the owner's:
the signed pairing with the label "Slack (MausBot Cloud)" and no member's claim. It proves:

- **The list** (`GET /api/slack/team/bots`) is every bot, each `shared: true`; a request with no session is refused.
- **A channel message** (`audience: "team"`) is the owner's own line in a new conversation: `202`, the reports
  `running` then `completed` with the reply, the conversation titled "Slack #sales: …" and not shared, the line not
  relayed, the engine's prompt with nothing relayed or information only, and the bot still opening to its own chat.
- **The same id again** answers as the first did, while the run works, after it ended, and from another session of the
  owner's: one line, one reply, one conversation, one `completed`.
- **A direct message** (`audience: "member"`, `{ default: true }`) is a conversation with the Cloud's MausBot titled
  "Slack DM: …"; `{ name }` ignores case; a direct message's conversation becomes the chat its bot opens to as any
  conversation the owner writes in does, and a channel's never does. A thread continues by `conversationId` with either
  audience; an id that names nothing answers `409 no_such_conversation`, a bot that does not exist `404 no_such_bot`.
- **A line written while the bot works** is taken (`202`), waits, and runs after as its own turn: both are reported
  `completed`, each with its own reply.
- **Stop** ends the owner's run and is reported `stopped`; an id never taken is 404; with no session it is refused.
- **Every report** verifies in Slack's context with the bootstrap secret and under no other context of this Cloud's.
  What the Cloud keeps holds no word of a message or an answer, no channel's name and no Slack user; it names the
  channel's conversation by id and not the direct message's, and no sharing file is written.
- **An install that is no Cloud** (the desktop's own server) answers 404 with no code on all three routes.

Not driven on a My Cloud: an approval reported as `waiting`, a final report sent again after a 503, and a guest's
session (a My Cloud revokes every session that is not its owner's at each boot). Those paths are the same code the
Team Cloud's test drives.

## What only a real Slack workspace and the real Admin prove

That Slack delivers the events, that the Admin matches a Slack user to a member and opens their session, that its
retries carry the same id, that its words for each answer and report read well in a thread, and that a Cloud asleep is
woken for a message. The Admin's own tests in openmaus-cloud run it against a fake Cloud that follows the same
contract; no run has joined the real two.
