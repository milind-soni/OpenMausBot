# The move to My Cloud

What it covers: the one-time move of everything on this computer to My Cloud
(its transport, what it carries and its check), and the line either page shows
while it goes.

## Two real servers

```sh
pnpm exec vitest run server/cloud-send.e2e.test.ts server/cloud-send-move.e2e.test.ts server/cloud-send-kinds.e2e.test.ts server/cloud-send-store.e2e.test.ts server/cloud-send.test.ts
pnpm exec vitest run server/cloud-send-kinds.test.ts server/cloud-send-memory.test.ts server/cloud-send-files.test.ts server/cloud-send-attachments.test.ts server/cloud-send-settings.test.ts
node --test electron/cloud-send.node-test.mjs electron/cloud-send-move.node-test.mjs electron/cloud-send-check.node-test.mjs electron/cloud-send-kinds.node-test.mjs
```

`scripts/testing/cloud-send-fixture.ts` starts this computer's server as the
desktop app starts it (its private utility-process port over Node's IPC) and a
Cloud home paired the way the Admin pairs it, with main's own wiring
(`electron/one-home-main.mjs`, which installs `electron/cloud-send-main.mjs`)
between them through a fake `ipcMain`. Temp homes, a synthetic Claude CLI and a
fake 1Password SDK; no network. `fx.olderSend` sends as an older desktop's Send
everything did, so a test can start from what such a send left on My Cloud.

`server/cloud-send.e2e.test.ts` checks:

- when My Cloud's 1Password refuses this computer's token, everything else
  arrives and My Cloud's notice says *1Password* and why, never a login's site;
- an attachment a row names is kept on My Cloud under its own name, once;
- **a long conversation, carried in pages by the move** (tool-heavy turns, so a
  few turns make several 300-row pages): a new bot's conversation of three
  pages and more, a later pass of two pages and more, a context summary that
  ends a pass, and a room of three pages and more (made on My Cloud under the
  same ids). Each is read back on both servers the way the chat view pages it,
  and the path from each server's own leaf, which is what its bot reads, must
  match row for row, summaries included.

`server/cloud-send-move.e2e.test.ts` runs the move as main runs it (`move`, then
`move({ final: true })`, then `check`): a 1,599-row conversation with 22
context summaries, a 610-message room and a conversation both sides added to
pass the path check; MCP servers with their keys and header tokens, an MCP
sign-in of its own (left here by the first pass, carried by the final one and
let go of here), an AI key, HighLevel by its token and the connected-apps
account (a fake broker) arrive, with equal credential fingerprints; the move's
session counts as someone using My Cloud; a moved conversation may use a lent
Mac and feeds its bot's memory on My Cloud; and a move run again changes
nothing there.

`server/cloud-send-kinds.e2e.test.ts` runs what only a move carries, then the
check, then the move again: a routine naming this computer's folder, with a
finished run, arrives switched off under its id, as the owner's, naming My
Cloud's folder; a scheduled call arrives unscheduled; a webhook arrives off
with an address and secret of its own; an app event goes only in the final
pass, and this computer stops collecting it. Bot files arrive by path and
bytes, a file My Cloud has another version of is kept beside it, and nothing
under `node_modules` goes. Memory on both sides merges with each fact once,
daily logs and the journal included, as do what bots learned about the person
and a team's context and memory. Archived, pinned, Chief, projects and fallback
models reach the bot; a conversation's project, model, approval and snooze and a
room conversation's time limit reach it too. A reply over 1 MB arrives whole,
imported, Claude Code and library skills arrive, and a model on the home network
stays here. `check()` is ok, and a move run again changes nothing.
`server/cloud-send-rooms.e2e.test.ts` runs the move over every shape of room: one
with history arrives; one nobody wrote in yet (as a team setup or a package
makes it, with a bot that lives only there) arrives as its thread with no rows;
one whose bots were all deleted here is never made there and the check leaves it
out with its conversation; one an older send carried and the person then removed
on My Cloud stays removed and the check leaves it out. `check()` is ok, and a
move run again changes nothing. A check that finds something missing logs the
rooms and conversations by id (`electron/one-home.mjs` `missingOf`).
`server/cloud-send-store.e2e.test.ts` fills My Cloud's attachment store: the
attachment is refused in plain words, its chat still goes, no partial file is
left, and the check names the attachment.

`server/cloud-send-chats.test.ts` covers the row cursor (pages, a deleted row
starting a conversation over, each page's own leaf, a page never ending between
a row and a row above it that was stored after it) and My Cloud's side (pages
of one conversation continuing one another, summaries kept, a removed
conversation or room never coming back, a busy one waiting, a room made under
the sender's ids). `electron/cloud-send.node-test.mjs` covers main's paging (a
page's `sent` as it goes, a conversation's later pages waiting once one is not
taken) and a send that goes on once My Cloud is back after being away. `server/login-handoff.test.ts` and
`electron/cloud-send.node-test.mjs` cover the
rest of the reasons a person reads: a pass that stops as a whole, logins this
computer's server did not hand over, and a 1Password token 1Password already
refused here.

My Cloud's welcome (`src/components/cloud-welcome/CloudWelcome.test.ts`): while
the move runs, or once it has gone, **Bring your stuff** is done by itself, so
the welcome goes straight on to the AI with nothing to press; back on that step
it says so in one line, with a fresh start only behind **More**. Before anything
has come, it offers a fresh start. The move never shows as a strip over the page
(`src/components/CloudSendStrip.test.ts`): it lives in the account area at the
bottom of the sidebar (`src/components/AccountMove.test.ts`). On its way, the
account line says "Moving to My Cloud…" and so does one row in the account
menu, with the progress in its tooltip; after a day of failing the line says "My
Cloud move needs you" and ends with Try again, the avatar gets a red dot, and the
menu's top row says "Try My Cloud move again", the size of every other row, with
the reason in its tooltip. Both run the one retry, and both wait with a spinner
while it runs. On My Cloud's page the menu says once what arrived, with the phone
to pair and Got it.

## The real utility port

```sh
pnpm build:server && pnpm exec electron scripts/smoke-login-handoff.cjs
```

CI's macOS smokes job runs it: main's own handoff client asks the packaged
server, forked as a real Electron utility process, for a saved login. The
fixture above emulates that port over Node's IPC.

## A real Cloud

Point the same pieces at a disposable Fly test Cloud set up like a customer's
(never a customer's): this computer's server started as the app starts it,
main's wiring with Node's own fetch, the Cloud paired through its signed
pairing route. Print each failed item's error, never a value.

## The move to My Cloud, by itself

```sh
pnpm exec vitest run server/one-home.e2e.test.ts server/one-home-retry.e2e.test.ts server/one-home-trial-key.e2e.test.ts
pnpm exec vitest run server/move-freeze.test.ts server/cloud-send-arrived.test.ts server/cloud-held-keys.test.ts
node --test electron/one-home.node-test.mjs
```

The same two servers, with main's move wiring (`electron/one-home-main.mjs`)
and a fake MausBot Cloud sign-in whose word the test sets (`fx.account`). The
fixture can kill and start again either server on its own data (`fx.relaunch`),
and can fail any request main sends My Cloud (`fx.intercept`). The e2e checks:

- a new buyer's move ends with home on My Cloud and its own check passing, with
  the app killed and opened again the moment each phase would be written down;
- §2.2's merge rules, the done line's counts, the webhook bot's one line, and
  this computer lent, its phone link stopped and My Cloud opened, once each;
- the frozen computer refuses turns and webhooks, never starts a routine (one
  that runs at every start included) through its restarts, and no routine
  occurrence runs on both sides;
- a check that can't pass lifts the freeze, switches nothing on, and tries again
  in an hour; after a day the line offers Try again, which finishes the move;
- when My Cloud ends, this computer is home again at once, then restores the
  held Cloud's backup (started export-only), its later chats included, and
  switches on what was on there;
- on a trial, a moved key is saved and checked but unused while the credit
  lasts (a stub plays the Admin's credit relay), and used once it runs out.

## Why a move hasn't finished: the report to the Admin

```sh
node --test electron/move-status.node-test.mjs electron/one-home.node-test.mjs electron/one-home-keep.node-test.mjs electron/one-home-main.node-test.mjs
node --test --test-name-pattern="where its move stands" electron/cloud-account.node-test.mjs
```

The real move (`createOneHome`, and `installOneHome` as main wires it) over
fakes, with the sign-in's state set the way the Admin's session leaves it. The
tests check:

- each reason a move doesn't start has its own code, through the move's own
  gates, and none of them starts a move: no sign-in, a sign-in the Admin can't
  vouch for now, no Cloud, only a team's, a Cloud setting up or ended, moves
  off, "Keep this computer's bots here", another account's move, this
  computer frozen with no move, its server not answering, and already moved;
- each phase's failure has its own code and phase (a network failure, an owner
  session refused, the Admin's 429, this computer's server, My Cloud refusing
  or answering nothing, the freeze, the check after three passes, the switch),
  is counted from the first until the move is done, and its sentence leaves
  without what My Cloud said, quotes, addresses, paths or tokens;
- the wait says whether it waits for a quiet moment or for work, by its kind
  only, and a stage is dated once however often the wait looks again;
- the report goes a moment after a change, at most once a minute, every 15
  minutes otherwise, holds off six hours from an Admin without the route, and a
  send that fails, throws or never answers changes nothing in the move.

