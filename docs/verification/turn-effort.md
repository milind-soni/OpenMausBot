# Automatic reasoning effort

Run `pnpm exec vitest run server/turn-effort.e2e.test.ts`. The test launches an
isolated fixture through `launchVerificationServer`, with only the fake Claude
engine and a loopback Jev-compatible helper. Its temporary home, database,
credentials and engine dump are removed when the fixture closes.

The checks cover default and conversational reply styles, Portuguese and
Russian message text reaching the helper, the selected model staying fixed,
the applied `--effort`, bot limits and their validation, uncertain answers,
fixed effort with the job on and off, room member metadata and stopping while
classification is pending. The helper is scripted: these checks prove wiring,
not the accuracy of a real provider.

For UI review, use a disposable preview and inspect Helpers' “Choose reasoning
effort” switch, the bot's advanced instruction settings and the turn's effort
note. Check Midnight and Daylight, a narrow window and keyboard focus. The
switch starts off; an own helper key is required. Included Cloud relay
credentials do not support this job. The bot's automation switch starts off.

Limits restrict successful automatic choices. An accepted Auto effort choice
keeps the selected model. On unavailable, timed-out or uncertain decisions,
conversational quick-model routing applies as usual; these limits do not
constrain the fallback engine's default effort.

Automatic choices intersect the engine's levels with model-specific levels
when the catalog reports them. Codex supplies these through `model/list`;
Claude's bundled model manifest records the documented support, including no
effort for Haiku 4.5. A model-specific empty list disables automatic effort.
For models without that metadata, the driver capability list remains the
source of truth. Sources: [Codex's model schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/ModelListResponse.json)
and [Claude effort support](https://platform.claude.com/docs/en/build-with-claude/effort).

An optional paid semantic evaluation is available with
`OMB_TURN_EFFORT_LIVE_EVAL=1` and `OMB_JEV_API_KEY` set, by running
`server/decider/turn-effort.eval.test.ts`. It is skipped in ordinary test runs.
