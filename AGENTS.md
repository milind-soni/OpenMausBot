# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.

## Harness work (the phased harness programme)

The harness plan of record is `docs/plans/2026-09-14-phase-0-foundation.md` and
its successors under `docs/plans/`. These rules keep that programme intact.

1. **Start from current main.** Before designing or building a phase, fetch
   `origin/main` and rebase the working branch onto it. Plans are re-read against
   what main has since gained; a plan written against stale code is revised, not
   followed.
2. **Check the open and closed PRs first.** Search the PR list for the ground the
   phase touches (`gh pr list --state all --search "<terms> in:title"`). For every
   overlapping PR say in the plan and in the PR body which it is, and one of: it
   conflicts and how the conflict is resolved; it taught us something and what;
   or it is superseded by this work and why. Never rediscover a closed PR's
   lesson the hard way.
3. **Every item works on every engine.** Claude Code, Codex, pi, the ACP family,
   the OpenAI-compatible family and the box agent each get a stated decision:
   full, degraded (say what is lost), or not supported behind a capability flag.
   Engine-specific channels (Claude hooks) are accelerators, never the baseline.
4. **Test locally before any PR, and measure.** Unit and matrix e2e tests against
   the fakes in `server/testing/` first; then a side-by-side app build
   (`~/.claude/skills/test-locally`) and the harness scorecard
   (`docs/verification/harness-scorecard.md`) on main and on the branch, one
   after the other. A change that makes the numbers worse is fixed locally or
   dropped; it is not raised as a PR with a promise to fix later.
5. **Run the real checks.** `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`, and
   the full vitest suite on the final tree. `npx tsc -p .` alone misses server
   errors.
6. **Raise PRs last, stacked and small.** One PR per reviewable step, base each on
   the one below, with the Platforms table (`~/.claude/skills/raise-pr`) and the
   scorecard numbers in the body. Findings that were pulled forward or deferred
   are recorded in the plan under "Findings", never left implicit.
7. **Walk the user's first run before asking the user to.** Fakes and scripted
   e2e tests only confirm what the author thought of (2026-09-16: three board
   defects passed every test and failed the first hand test). So before a PR is
   handed over for hand testing:
   - **Fresh bot, default settings, real engine, every new flag on together.**
     A standalone harness on a throwaway data folder (never the user's), one bot
     created with no settings changed, the phase's flags switched on at once,
     and the same steps the hand-test guide will give the user, driven through
     the app's own routes. Record the bot's actual replies in the PR under
     "Tried by hand".
   - **Every tool is tested as a bot, not as a person.** A route test that calls
     the internal route with a minted bot capability (the fixture launcher
     forwards `OMB_TEST_INTERNAL_CAPABILITY_KEY`), including the case where the
     bot names itself.
   - **Nothing waits in silence.** Wherever a rule stops something from running
     (approval setting, cap, missing peer, flag off), a test asserts the reason
     is shown to whoever is looking — the bot's reply, the task, the run.
   - **Say exactly what was tried live.** "Passes live" names the flows run and
     lists the ones not run. A flag combination that was not run is not tested.
   - **Write test-folder settings only while the app is closed**, and confirm
     them after boot through a route that depends on them, not the config view.
