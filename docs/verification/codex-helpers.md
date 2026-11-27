# Codex helper event isolation

The app-server streams events from both the requested parent and native helper
threads. Only the exact parent thread and turn returned by the start handshake
may update the parent transcript, usage, or completion. Scoped child/stale errors
are excluded too; connection-level errors still surface. Approval requests
continue through the existing broker, including requests from helpers.

Run `pnpm exec vitest run server/drivers/codex.test.ts` for interleaved helper,
stale-turn, missing-scope and early-notification regression checks. The helper
test fails on the old driver: it emits the child's final and kills the parent
before its next approval. The fixed driver answers that approval and completes
only after the parent final, with parent usage.

For the real chat path, run `node scripts/verify-codex-helpers.ts` in the foreground
and open its printed preview URL. This uses the standard isolated launcher and
an offline Codex protocol fixture; no real provider or user account is used.
Select **Codex Helper Fixture**, send a message, and check that **echo parent
continues** requests approval after the simulated helpers have completed.
No **FOREIGN** text, reasoning, tool, error or usage should enter the chat.
Approve once: the parent returns **done from fake codex** and then settles.
Repeat and deny the approval to verify that rejection remains answerable and
does not leave the run stuck. Read the console and retain screenshots plus the
fixture log. Stop the foreground launcher with Ctrl-C for scoped cleanup.

This proves the renderer/harness workflow with scripted native events, not
authenticated model behavior or activation in the installed desktop app.
