# server/host — the server's host modules

`server/index.ts` is being taken apart into modules that live here (and in
`server/routes/` for HTTP routes). The rules, so the file never grows back:

1. **One module per concern, with explicit deps.** A module exports a factory,
   `createArea(deps: AreaDeps)`, that returns the functions the rest of the
   server calls. The deps are the singletons it needs (`store`, `cfg`,
   `registry`, `bus`, `coordinator`, `sessions`, `broadcast`, `notify`…), passed
   in by `server/index.ts`, which stays the only composition root. A module
   never imports `server/index.ts`.
2. **State moves with the code.** The module-scope `Map`s and `Set`s a region
   owns live inside its factory, created once, in the same order as today.
   Shared state another area reads is exposed as a function, not a bare `Map`.
3. **Moves are moves.** A PR that moves code out of index.ts changes no
   behaviour: function bodies are byte-identical (review with
   `git diff --color-moved=dimmed-zebra`), and behaviour changes go in their own
   PR before or after. Comments move with their code.
4. **Order that matters stays in index.ts.** The top-level `await`s and the
   `bus.subscribe` registrations keep their order there: a moved fold is a
   function index.ts registers at the same point it used to live.
5. **Late-bound singletons are constructor order, not hoisting.** A `let` that
   index.ts assigned far from its declaration (`routines`, `calendarCalls`,
   `orgLibrary`, `workspaceAccess`…) becomes a small getter in deps
   (`deps.routines()`), never a reference to a hoisted name.
6. **Tests follow the code.** A test that sliced index.ts by source text
   (`readFileSync(... index.ts)` + markers) either imports the new module
   directly, as a real unit test, or is deleted when an end-to-end scenario
   already covers the behaviour. A loader hook that rewrote index.ts rewrites
   the new file.
7. **Size is enforced.** `scripts/testing/file-size-ratchet.test.ts` lists every
   source file over 1,000 lines; a listed count may only go down, nothing new
   may pass 1,000 without a line there, and nothing may pass 2,000. New modules
   here stay under 1,500 lines, most under 800.
8. **Routes** keep the rules in `server/routes/README.md` (a `createXRoutes`
   factory, one `ROUTES.push`, `PASS` when not yours) and the route ratchet in
   `scripts/testing/index-route-ratchet.test.ts` goes down with every move.

Order of the split (facts and line maps in the program's notes): routes out of
the request handler, then cards and proposal services, computers, turn
admission and `startTurn`, rooms and the coordinator host hooks, the event
folds, identity and wire projections, boot and shutdown.
