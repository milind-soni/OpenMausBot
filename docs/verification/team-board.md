# The Team Board with a real model

The contract is [team-board.md](../team-board.md). The tests drive it with the synthetic Claude CLI:

```sh
pnpm exec vitest run server/board server/cloud-team-board.e2e.test.ts server/cloud-team-board-dispatch.e2e.test.ts \
  server/drivers/agents-catalog-wire.test.ts server/drivers/agents-tool-groups.test.ts
```

- `server/board/dispatcher.test.ts`: one bot gets one item at a time and two bots two at once; `forBotId`; a spend cap
  pauses everything and counts no attempt; a bot with no model is passed over for ten minutes; a turn that ends without
  settling hands the item back and the third fails it; nothing starts in the first two minutes or twice; a dependent
  starts once its need is done; a refused start; a person's reply; an inbox answer; `later`.
- `server/cloud-team-board-dispatch.e2e.test.ts`: a Team Cloud whose board waits run 20 times faster
  (`OMB_BOARD_TIME_SCALE=0.05`); the tools are listed only with the switch on; a person's item reaches Writer as
  unattended work (its usage row's trigger is `bot`) and its done result reaches the review that needed it; an ask
  lands in the maker's inbox, the room thread shows waiting on you, and her reply goes to Writer although Reviewer is
  the room's default; `board_add` from Lead; `later`.

What only a real model shows is whether a bot reads its line and uses the tools well. That pass is by hand.

## A throwaway Team Cloud

```sh
# One provider key is enough; only these names cross into the server (scripts/launch-team-board.ts).
export OMB_OPENROUTER_API_KEY=…        # or OMB_ANTHROPIC_API_KEY (Claude bots on the API; the claude CLI on PATH), or OMB_OPENAI_API_KEY
# Optional, to wait less: OMB_BOARD_TIME_SCALE=0.1 makes the quiet minutes 12 s, the lease 2 s and a `later` minute 6 s.
node --experimental-strip-types scripts/launch-team-board.ts
```

It makes a temp folder for the server's HOME and data folder (never `~/.openmausbot`), starts a Team Cloud with the board
on, pairs an Owner (olive@board.test) and a Member (mira@board.test) with the Admin's signed claims, and prints the URL,
both tokens and a header line `H`. Ctrl-C stops it and removes the folder. `--offline` starts it with no network at
all, to check that it starts and pairs.

In a second terminal, with the printed `BASE`, `OWNER`, `MEMBER` and `H`:

```sh
curl -s $H -H "authorization: Bearer $OWNER" $BASE/api/instances | jq '.instances[] | {instanceId, authenticated: .snapshot.authenticated}'
# Three bots on the provider's instance and model, everyone may chat:
for name in Lead Writer Reviewer; do
  curl -s $H -H "authorization: Bearer $OWNER" -X POST $BASE/api/bots \
    -d "{\"name\":\"$name\",\"visibility\":\"everyone\",\"modelSelection\":{\"instanceId\":\"INSTANCE\",\"model\":\"MODEL\"}}" | jq -r '.bot.id'
done
# A room with all three; Lead answers what nobody addresses:
curl -s $H -H "authorization: Bearer $OWNER" -X POST $BASE/api/groups \
  -d '{"name":"Launch","memberIds":["LEAD","WRITER","REVIEWER"],"setup":{"bulletin":"","defaultResponder":{"kind":"member","botId":"LEAD"}}}' | jq '.group | {id, threadId}'
```

## The pass

1. **Lead splits a goal.** As Mira, write in the room's thread: `@Lead Plan our launch post: Writer drafts it, Reviewer
   reviews the draft. Put it on the board with board_add.` Expect two new room threads with items; the review `needs`
   the draft and is `for` Reviewer (`GET /api/board`).
2. **A worker takes it.** About two minutes after the server started (sooner with the scale), the draft goes to Writer:
   its thread gets a line from Board starting `@Writer`, and Writer works there.
3. **Kill it mid-run.** While Writer works, write `@Writer stop` in the draft thread as Mira. Writer's turn stops and
   Writer is held in the room. Within about 20 s the item is `ready` again with `attempts: 1`, and the next free member
   bot (Lead or Reviewer) is started on it (`attempts: 2`); held Writer is not (lift the hold as `server/room-holds.ts` says).
4. **The bot asks.** Tell Writer in the draft thread to ask Mira which date to name before finishing. Expect the item
   `needs_person` with `question.person` Mira's key, Mira's `GET /api/inbox` listing the question, and the room thread's
   `activity` `waiting-on-you`.
5. **The person replies.** As Mira, write in the draft thread: `Friday the 5th.` The line is saved as
   `@Writer Friday the 5th.`; Writer, not Lead, answers, and the item is `working` again. Answer from Mira's inbox
   instead (in the app, or by answering her inbox line) on a second ask: Writer is started with that answer once it is free.
6. **The dependent readies.** When Writer calls `board_update done`, the review becomes `ready` and goes to Reviewer,
   whose line from Board lists what the draft came to.
7. **Later.** Ask a bot to `board_update later` with `minutes: 1` and a note; the item stays `working`, the bot takes
   other items meanwhile, and after a minute the same bot gets a Board line with its note.

Things to look for: each Board line is in the thread's language; the usage page counts these turns as the bot's own
(unattended), never as Mira's request; nothing asks anyone to approve anything; a spend limit set below what is spent
(Settings → Spending) leaves every ready item ready and starts nothing until it is raised.
