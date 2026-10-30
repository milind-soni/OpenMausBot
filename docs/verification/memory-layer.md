# Memory: recall, upkeep and the tidy-up

Automatic recall, the topic index and until dates only read memory. Memory
upkeep (background capture into MEMORY.md and topic files, About me learned
from the person's words, and the nightly tidy-up) is on unless a bot's switch
is off, and every memory write is a journaled, undoable row. See [the memory guide](../memory.md).

## Exercise the real path

```sh
pnpm exec vitest run server/memory-layer.e2e.test.ts
pnpm exec vitest run server/reply-behaviour.e2e.test.ts
pnpm exec vitest run server/memory-forget.test.ts server/drivers/agents-call.test.ts
pnpm exec vitest run server/memory-capture-restart.e2e.test.ts
pnpm exec vitest run server/spend-cap-api.test.ts
pnpm exec vitest run server/memory-entries.test.ts server/recall.test.ts server/memory-upkeep.test.ts server/workspace.test.ts
pnpm exec vitest run server/side-jobs.test.ts server/helper-model.e2e.test.ts
pnpm exec vitest run src/components/bot-settings/MemorySection.test.ts src/lib/memory.test.ts server/drivers/agents-catalog-wire.test.ts
```

The API fixture launches the shared isolated server with the fake engine. The
capture and tidy-up model calls are answered by `FAKE_CLAUDE_TEXT_ROUTES`, a
JSON file mapping a prompt marker (`CAPTURE_MARKER`, `TIDY_MARKER`) to a
reply, re-read on every call so a step can change it. `FAKE_CLAUDE_PROMPTS`
records every turn the engine received, which is where recall shows.

Evidence covers:

- A topic file is listed with its title and aliases, and found by an alias the text never uses.
- A fact said in one chat is recalled in a new chat, named by its source.
- An entry past its until date leaves the prompt; one without a date stays.
- A new bot has upkeep on; switched off, nothing is captured and **Tidy up now** is refused.
- A rejected settings update does not discard a queued capture or change the upkeep switch.
- Upkeep on: core facts are appended as dated, `(noticed)` entries with their until date; detail is filed into a topic file created with a title and aliases; all journaled as upkeep.
- `Balance is -10` captured twice is kept once; `Balance is 10` is a different fact.
- A fact about the person reaches About me on its own as a dated, attributed line in the prompt; Remove takes it out and a second Remove is refused.
- The tidy-up archives the expired entry and strikes the contradicted one, reports it, and Undo restores the file.
- A routine run is not captured as a person's conversation and never adds owner facts to About me.
- A turn still waiting for the quiet spell when the server stops is saved as ids only, read back from the transcript after a restart, and captured then (POSIX: a Windows SIGTERM skips the shutdown hooks).
- `server/reply-behaviour.e2e.test.ts` (TZ pinned to Asia/Kolkata, the room-plan agent calling the real agents tools): every bot's prompt, the preview and a real turn's, carries the reply habits and the remember-and-forget guidance. "Remember: …" is in `MEMORY.md`, where **What it remembers** reads, as soon as that turn ends. The learner, answered with two guesses (one quoting a question, one with no quote) and two things the person said, adds only those two to About me and nothing anywhere else. "Forget both" removes them from `MEMORY.md` and About me, leaves no dated line without words, and the bot's tool results name no file. Remember and forget inside one learner batch leave nothing behind. A weekday routine's result says "India time", never `Asia/Calcutta`, and asks for the first run in words. A tap-to-answer card does not hold the chat: a typed reply runs as the next turn and the card stays answerable.
- Background calls book their actual helper model, tokens and cost to the bot's usage. Capture, organization and contradiction checks each respect the configured monthly cap; free deterministic cleanup still runs at the cap.
- With the `helper` setting naming an instance (`server/helper-model.e2e.test.ts`, its own server with the fake Claude, Codex and Pi engines): a Pi bot, whose engine has no one-shot text call, captures through the helper with the model the setting names, booked as a helper call for that bot, and its conversation is reviewed for skills the same way; a Codex bot beside it keeps its own background call for upkeep, and a Claude bot its own engine and quick model. Without the setting the Pi bot reports no model steps. A Pi bot switched to never use the helper (`PATCH /api/bots/:id` with `helperModel: false`; a wrong type is refused and the switch is in `bots.json`) reports no model steps, has its capture and its skill review refused for want of an engine and gets the excerpt summary, with no helper call booked; switched back, it has model steps again. A bot created with `settings.helperModel: false`, which is what the sidebar's Duplicate sends for a source kept off the helper (`src/lib/bot-duplicate.test.ts`), has the switch in its saved record before any later request. The second server also shows the setting followed from `config.json` as the file changes, and a settings request unable to set or clear it.

Unit tests add the share limit on small notebooks (no contradiction change below
five entries), the nightly schedule (once a day after the hour, never while the
bot is busy, catching up after sleep), backup pauses, and engines without a
one-shot text call. They also cover expired topic facts disappearing from both
alias recall and the search index after midnight without a file edit, retrying
malformed organization output and deferred moves, Unicode topic names, and
stopping upkeep writes when its switch changes during a model call. Search
checks use actual index results for signed-number/symbol false matches and
historical files crowding out current topics. A failed topic write leaves its
notes in the notebook; retrying completes only the remaining moves.

## Not proven here

The fake engine answers the model steps with scripted JSON, so these tests
prove the plumbing, not the quality of what a real model captures or judges
contradictory. Check that by hand with a real Claude bot: switch upkeep on,
mention a preference in passing, wait two minutes, and read the Memory panel.
The `live-reply-*` scenarios of the live tier ([evals](../../evals/README.md))
grade a real model's replies to "remember", a research question, "Plan my
week.", a routine and a dead link with the `reply-habits-v1` judge.
