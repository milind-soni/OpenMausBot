# A server of the person's own as their bots' home

What it covers: **Make <server> my home** on a server's circle, the one-time move
of this computer's bots to that server, and this computer then working for it by
itself; and that none of it happens for a server other people sign in to.

```sh
pnpm exec vitest run server/own-home.e2e.test.ts server/own-home.test.ts server/move-freeze.test.ts
node --test electron/own-home-main.node-test.mjs electron/lending-target.node-test.mjs electron/lend-automatically.node-test.mjs electron/one-home-main.node-test.mjs electron/cloud-rail.node-test.mjs electron/home-window.node-test.mjs electron/cloud-connections.node-test.mjs
```

`scripts/testing/own-home-fixture.ts` starts this computer's server as the
desktop app starts it, and servers of the person's own (`openmausbot serve`,
nothing of MausBot Cloud), each paired as a pairing link pairs it, with main's
own wiring for the move (`electron/own-home-main.mjs`) between them. Its
requests carry the pairing's session as the window's would. Temp homes and a
synthetic Claude CLI; no network.

`server/own-home.e2e.test.ts` checks:

- a server paired only with the person (no members, no other admin) says the
  session is its owner's (`own` on `/api/auth/session`) and that it takes a
  move; one with a member on its sign-in list says neither, is never offered,
  refuses **Make … my home** in plain words, and its move routes refuse that
  session;
- the move to the person's own server, with the app killed the moment the
  freeze and the switch would be written down: bots, a chat, a memory note and
  routines arrive under the same ids, the server switches on only what was on
  here, the webhook's bot says once (naming the server) that its address
  changed, this computer is frozen for good and refuses a turn with "This bot
  lives on <server> now.", its project folder is lent with the server, its
  phone link stops and the window opens the server;
- no occurrence of any routine runs on both sides, and the one due right after
  the move runs on the server only;
- this computer's real lending (`createComputerSharing` over
  `createLendingTarget` with the move's `home()`) lends itself to the person's
  own server with no click and never the terminal, lends nothing to the server
  it shares with others, and Pause stops it.

The node tests add the rest: a choice is bound to the server's identity, the
offer needs the server's fresh word that it is the person's alone and no move
under way, Make … my home is refused on My Cloud, a team's Cloud, a server not
signed in or too old; every pass goes over the window's sign-in to that server
only and never signs it out; lending to that server stops once it has other
people on it or another server answers at its address; while a server of the
person's own is chosen no move to My Cloud starts; the frozen screen names the
server and never asks for a MausBot Cloud sign-in; and connected apps through
MausBot's service stay on this computer (a final, plain reason) when the server
has no such service, so the move's check still passes.
