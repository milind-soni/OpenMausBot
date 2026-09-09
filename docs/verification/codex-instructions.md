# Codex bot instructions

The driver sends bot rules as `developerInstructions` on thread start and
resume. Ordinary turn input contains only the current message and images.
The effective native `developer_instructions` are read for every approval mode
and retained after the bot rules in that block. Removing bot rules does not
remove the user's native configured rules. Effective configuration and outgoing
developer blocks are omitted from diagnostic logs. If configuration cannot be
read, the turn fails before changing native history instead of overwriting
unknown instructions. Approval/sandbox parameters and permission-profile
fallback remain unchanged.
Codex 0.147.0 and 0.153.4 retain the original developer message on resume, even
when configuration changes. Therefore a changed instruction block also needs a
`thread/inject_items` developer update before the next user turn.

The driver stores a SHA-256 receipt per OpenMausBot/native-thread pair under
`codex-instructions/` in the data directory. It contains no prompt text. Native
injection flushes history before acknowledging; the receipt is written only
after that acknowledgement. Unchanged rules need no injected update. Missing
receipts (including sessions created before this change) cause one adoption
update. Current thread configuration restores the latest rules after compaction.
Removed rules get an explicit developer update and empty native configuration.

A rejected native resume fails the turn instead of starting an empty thread.
The existing history and cursor remain available; automatic canonical replay is
separate work in #759. Unknown native-update methods fail before user submission
with an upgrade error. Approval and sandbox parameters are unchanged.

## Checks

```sh
pnpm exec vitest run server/drivers/codex.test.ts server/drivers/codex-instructions.test.ts
pnpm typecheck
pnpm test
node --experimental-strip-types scripts/verify-codex-instructions.mjs
PROBE_BEFORE=1 node --experimental-strip-types scripts/verify-codex-instructions.mjs
```

The optional native verifier requires Codex on PATH. `PROBE_CODEX` can select a
specific executable. It uses temporary homes, native persisted threads, and a
loopback Responses API fixture; it uses no credentials or authenticated model
inference. It restarts the app-server between turns, edits/removes rules, runs
manual compaction, asserts model-request bodies, and prints retained temporary
evidence paths. A native configured rule is checked through bot-rule edits,
removal and compaction. Synthetic replies and summaries prove protocol behavior, not
model quality, semantic compaction fidelity, or token/cost savings.

Verified on macOS with Codex 0.147.0 and 0.153.4. Older releases have not been
runtime-tested. Five identical 49-character instruction blocks produce 1, 2,
3, 4, 5 copies in the original approach and one copy in each request after the
fix: 245 versus 49 instruction characters on request five. These are actual
fixture marker/character counts, not measured tokens. Changed blocks append an
update; this is not deduplication of shared sections between different blocks.
Historical copies from sessions created before the fix are not deleted.
Goal counters, team status, selected skills, and memory can change between
turns and cause another full developer update. Deduplication applies only to
identical complete instruction blocks, not every production conversation.

An additional authenticated smoke on Codex 0.153.4 with Astra medium used four
synthetic read-only turns and a fresh app-server process for each. Replies were
ALPHA, ALPHA, BETA, GAMMA: unchanged rules persisted, edits took effect on the
next turn, and removal let the current user request determine the reply. This
was a bounded rule-following check, not a token-savings benchmark.
