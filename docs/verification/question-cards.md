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
