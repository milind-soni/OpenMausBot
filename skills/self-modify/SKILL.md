---
name: self-modify
description: Propose safe, reversible edits to OpenMausBot's own code through the journal + watchdog rollback pipeline. Use when a task requires changing the bot server itself rather than working within it.
---

# Self-modify: changing this server's own code

You can improve the server you run on, but never directly: you **propose**
changes as files, and a gated pipeline validates, applies, trials, and —
if anything breaks — reverts them automatically. The safety machinery is
not editable, by anyone, including you.

## When to use this

- A task fails because the **server lacks a capability** you can name precisely.
- You found a concrete defect (a crash, a wrong result) and know the minimal fix.
- A user explicitly asks for a change to the bot server itself.

Never propose speculative rewrites, style changes, or anything you cannot
state as: *file, change, why it is safe, how it was or will be proven*.

## The protocol

1. **Read the current file first.** Never propose a change to a file you
   have not read in this session — your proposal must be based on the real
   code, not memory. Your working folder mounts the app's source tree only
   if the operator configured it that way; if you cannot read the file,
   you cannot propose a change to it.

2. **Write a proposal JSON** to the pending inbox:

   ```
   <DATA_DIR>/self-modify/pending/<your-id>.json
   ```

   (On desktop installs `<DATA_DIR>` is `%USERPROFILE%\.openmausbot`.)

   Shape:

   ```json
   {
     "id": "add-retry-grok-2026-09-12",
     "proposedBy": "bot:<your name>",
     "reason": "One or two sentences: what is wrong, what this fixes.",
     "files": [
       { "path": "server/drivers/grok.ts", "action": "edit", "content": "<ENTIRE new file contents>" }
     ],
     "testCommand": "pnpm vitest run server/drivers/grok.test.ts"
   }
   ```

   Rules: `id` is a short unique slug; `path` is relative to the project
   root and must start with `server/`, `shared/`, or `src/`; `action` is
   `edit` | `create` | `delete`; `content` is the **whole new file** (not a
   diff) for edit/create, omitted for delete. Max 8 files per proposal.

3. **Tell the person.** Proposals are visible in Settings and the operator
   applies them. Say what you proposed, why, and what it changes — then
   continue with the task using today's behavior.

## What the pipeline does with it

- **Validation** — source-tree paths only; protected paths (this skill, the
  journal, the watchdog, config) and protected content (anything touching
  the gate, the revert machinery, or `OMB_SELF_MODIFY`) are refused.
- **Journal** — originals are snapshotted byte-for-byte before the first write.
- **Preflight** — changed server files must pass `node --check`; dependency
  changes install with scripts disabled. Failure auto-reverts.
- **Trial boot** — a server-touching proposal is judged on the next boot:
  a crash, wedge, or failed boot reverts automatically (a detached
  watchdog watches for exactly this). A boot that serves verifies the change.
- **Runtime apply** — the running server keeps its current behavior until
  its next restart; nothing changes under the user mid-conversation.

## Hard limits (non-negotiable)

- You cannot edit: `server/self-modify.ts`, the watchdog, the journal, the
  skill itself, `package.json` (except dependency sections via the
  `packageJson` field), lockfiles, CI.
- You cannot write content that touches the gate, revert machinery, or
  `OMB_SELF_MODIFY` anywhere — even in an unrelated file.
- One server-touching proposal may be in flight at a time.
- Proposals are auditable forever: every apply is recorded in the journal
  with who, why, what, and how it resolved.
