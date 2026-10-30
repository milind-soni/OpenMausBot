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
something, and Scout hands it on with `coordinate_bots`. Expected:

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

Unit tests: `server/host/ask-cards.test.ts` (the card a parked question becomes, its stopped and expired states, the
chip that stays out of the inbox, typed answers), `server/runtime/envelope.test.ts` (the ask line with and without a
card tool), `src/components/QuestionCard.test.ts`, `src/components/QuestionCard.answer.test.ts` and
`src/components/AskCard.test.ts` (the card family, its buttons and settled lines).

## Finding a teammate's question in Simple mode

A direct-chat mention tells the current bot which teammate the person named.
The bot hands work on with `coordinate_bots`; the teammate asks in its work conversation.
Simple shows the existing **Waiting for you…** marker on that teammate's row or tile.
Text-only questions use the runtime's pending-answer state for the same marker.
Select it to open the waiting conversation and answer its question card.
After answering all waiting cards, selecting the bot opens its usual chat again.
The chat header's **Back to your chat** action also remains available.

```sh
pnpm exec vitest run src/components/Sidebar.teammate-question.test.ts server/simple-teammate-question.e2e.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/simple-teammate-question-ui.e2e.test.ts
```

The server fixture checks direct mentions, standing and new work conversations,
one-way handoffs, text-only questions, room mentions, chained mentions, and handoffs within or into a room.
The UI fixture starts with a person's own chat with each bot.
It sends a mention from the first bot's composer and scripts the teammate's real `ask_user` call.
It opens the question through Advanced's work link, then through Simple's waiting row, and answers it.
The component tests cover rows, compact rows, the avatar rail, tiles and keyboard selection.
They also check multiple waiting conversations and exclude archived conversations and hidden routine runs.

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
