# Question cards

A bot doing work another bot handed it asks the person with a card: a decision with a few set answers through its
engine's question tool, the bot's own choices as buttons, and any other question as the same card with a reply field in
place of its `NEEDS INPUT:` line. On a Team Cloud the card's copy reaches the person's inbox with the same buttons, and
an answer from either place, by tap or in the person's own words, reaches the bot. Contract:
[`docs/runtime-contract.md`](../runtime-contract.md) §2 and §4; routing: [`docs/team-cloud.md`](../team-cloud.md).

## Server, end to end

```sh
pnpm exec vitest run server/question-cards.e2e.test.ts
```

It starts a Team Cloud on the two-server fixture (`scripts/testing/cloud-send-fixture.ts`) with the scripted fake engine
(`server/testing/room-handoff-agent.ts`): Cleo asks Scout, her Chief, whose chat is her inbox, to have Ledger fix
something, and Scout hands it on with `coordinate_bots`. Both bots are on "Ask me first", so the questions are the
person's. Expected:

- Ledger's envelope offers its card tool for set answers (`ask it with ask_user`), and Ledger's turn calls the real
  `ask_user` server with three choices. The card is in Ledger's work thread, and its copy is in Cleo's inbox
  with the same choices, listed under Needs you, with one notification and no chip beside it.
- A tap on the copy (`POST /api/threads/<inbox>/respond`) answers Ledger's waiting tool call; Ledger's reply quotes the
  choice, Scout is resumed once with Ledger's report, and both cards read as answered.
- A line Cleo types in Ledger's thread while Ledger waits answers the card the same way, and stays in the thread
  under it.
- Ledger's `NEEDS INPUT:` question becomes a question card with no choices in place of its line, and a copy in the inbox.
  Scout is resumed once with the question and told not to repeat it; Cleo's reply on the copy reaches Ledger's next
  turn as `The person answered: "…"`.
- Stopping Ledger's thread closes an open question as stopped, in the thread and in the inbox.

## Who answers: Just do it and Ask me first

```sh
pnpm exec vitest run server/question-routing.e2e.test.ts
```

The same Team Cloud with Fuchs, Dachs and Otter on their default Full access ("Just do it"), then on "Ask me first".
Expected:

- Dachs's `NEEDS INPUT:` question with `Default: CSV` reaches Fuchs, not Marco ("yours to answer"); Fuchs sends no
  answer, so Dachs's next turn is told nobody was asked and to go on with CSV, and its card reads "Picked by Dachs: CSV".
  Marco gets no question notification, no Needs you row and no inbox line.
- Fuchs's own answer, sent to Dachs with `coordinate_bots` in the turn that carries the question, is the answer
  (`@Fuchs answered: "…"`); no new thread is opened.
- Dachs's sign-in reaches Marco once while Otter finishes and Fuchs carries on with Otter's result; Marco's line in
  Dachs's chat carries Dachs on.
- On "Ask me first" Marco's answer, passed on by Fuchs with `answers`, settles Dachs's question: the card, its inbox copy
  and Needs you follow, and no new task is made. A restart posts nothing again and the answer after it still reaches
  Dachs. A question whose asking turn a restart cut closes once Dachs's work goes on, and leaves Needs you and the inbox.

## Replies and follow-ups from the bot that handed the work on

```sh
pnpm exec vitest run server/teammate-follow-ups.e2e.test.ts
```

One server of the person's own (no Team Cloud, so no inbox copies) with the scripted fake engine: Clive, a Chief of
Staff, hands Mira work. Expected:

- On "Ask me first", Mira's `NEEDS INPUT:` question resumes Clive with it. Clive's reply to her thread in a later turn,
  without `answers`, answers it: Mira's next turn reads `@Clive answered: "…"`, her card says Clive answered, no second
  job starts, and her one result resumes Clive.
- The card Mira's ask tool waits on is answered the same way by Clive's later reply; her turn carries on with it.
- A correction Clive sends while Mira works on what he handed her reaches her running turn (receipt `injected`, a line
  from Clive in her thread) and her one result carries it.
- `thread` set to the id of one of the threads Clive opened on Mira sends his follow-up there, and its result comes back to
  him; the id of a thread he did not open on her is refused with where thread ids come from.
- Two assignments Clive hands Mira in one turn stay two jobs, though the first is already running when he sends the
  second.

Unit tests for the relay's rules (which thread, which sender, sign-ins, work handed out this turn, an engine that cannot
take a message mid-turn) are in `server/host/question-routing.test.ts`.

The fake clock: `server/runtime-coordinator.test.ts` keeps a question waiting past 30 minutes and three days on the
server's own limits. Relay rules, the Full-access answer for an ask tool, and sign-in settling are in
`server/host/question-routing.test.ts` and `server/host/sign-in-settle.test.ts`.

Unit tests: `server/host/ask-cards.test.ts` (the card a parked question becomes, its stopped and expired states, the
chip that stays out of the inbox, typed answers), `server/runtime/envelope.test.ts` (the ask line with and without a
card tool), `src/components/QuestionCard.test.ts`, `src/components/QuestionCard.answer.test.ts` and
`src/components/AskCard.test.ts` (the card family, its buttons and settled lines).

## The cards, side by side

```sh
pnpm exec vite --port 5287
```

`http://127.0.0.1:5287/question-cards-preview.html` mounts the real chat, inbox card and inbox panel over a fixed store
(`src/question-cards-preview.tsx`): `?state=question|approval|open|answered`, `surface=chat|inbox|panel`,
`skin=midnight|daylight`, `mode=simple|advanced`, `lang=de`; `state=others` shows the key, sign-in, connection and
first-run cards that share the card's shell.

The before-and-after screenshots were removed because they showed real example data. To see each screen, run the
command above and open `question-cards-preview.html` in a 1338×870 window with these settings (for Phone, narrow the
window to a phone's width):

| Screen | Settings |
|---|---|
| Set answers, chat | `?state=question&surface=chat&skin=midnight&mode=simple` |
| Set answers, inbox | `?state=question&surface=inbox&skin=daylight&mode=simple` |
| Set answers, panel | `?state=question&surface=panel&skin=midnight&mode=advanced` |
| Approval | `?state=approval&surface=chat&skin=daylight&mode=advanced` |
| Open question, inbox | `?state=open&surface=inbox&skin=midnight&mode=simple` |
| Answered | `?state=answered&surface=chat&skin=daylight&mode=simple` |
| Phone | `?state=question&surface=chat&skin=midnight&mode=simple` |
