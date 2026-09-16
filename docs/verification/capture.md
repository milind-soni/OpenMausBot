# Fact capture (Phase 4 part 1)

What it proves: with capture switched on for a bot, a fact said in passing in the person's own
chat lands in the bot's notebook after a quiet spell, marked as captured; small talk, low
confidence, unattended runs and bots with capture off produce nothing.

- Unit: `server/capture.test.ts` — the two prompts by speaker (the person's rules, the bot's
  stricter rules, the notebook shown so it is not repeated), strict JSON parsing with the 0.4
  floor and the cap of eight, normalisation and dedupe against the notebook and within a batch,
  the buffer's quiet and count flushes.
- End to end: `server/capture.e2e.test.ts` (fake engine) — "By the way, my dog is called
  Biscuit" becomes `- date · from chat "…", captured · my dog is called Biscuit`; "hello again"
  and a "maybe" line do not; the same fact said again is not appended twice; a board run on the
  same bot captures nothing; a bot with capture off captures nothing; `memoryCapture` accepts
  only true or false.

Switch: `PATCH /api/bots/:id { "memoryCapture": true }` (off by default, decision 16). Config:
`memory.captureQuietMs` (default 90 s). Calls are booked as `capture-person` / `capture-bot`
harness calls, fingerprinted per thread and last message. Engines: any with a one-shot call
(Claude, Codex); a bot on an engine without one is skipped and logged once.
