# Handoff hook for usage-limit switches

Off by default. When a conversation moves to a backup because its engine hit a
usage limit (Settings → General → Automatic recovery, or a bot's fallback list),
the server can first give an external program the chance to save the
conversation and to hand back a short note for the backup to resume from. The
program is yours; OpenMausBot depends on no particular memory system.

## Turn it on

Start the server with `OMB_ACCOUNT_HANDOFF_COMMAND` set to the **absolute path**
of an executable. It is run directly (no shell, no arguments) in the
conversation's pinned working folder. A relative path, or an unset variable,
leaves the feature off.

## The contract

The server writes one JSON object to the program's stdin and closes it:

```json
{
  "schemaVersion": 1,
  "event": "engine-switch",
  "reason": "usage_limit",
  "conversationId": "<bot id>:<thread id>",
  "cwd": "/the/pinned/working/folder",
  "from": "Engine that refused",
  "to": "Engine taking over",
  "summary": "The conversation so far, at most 8,000 bytes"
}
```

The program may print one JSON object on stdout and exit 0:

```json
{ "text": "A note for the backup, at most 8,000 bytes" }
```

`text` is added after the person's message on the backup's first turn,
inside a `<handoff-note>` block marked as historical data, not instructions. It
is not saved in the conversation.

## What can go wrong, and what happens

The switch never depends on the hook. If the program is missing, exits non-zero,
prints anything but that object, prints more than 32 KB or a note over 8,000
bytes, or takes longer than 8 seconds, the backup starts without a note. Stop
cancels a hook that is still running. The hook runs only for usage-limit
switches, only when the conversation already has earlier messages, and never
when the thread goes back to its own engine after the reset.

The summary is the same deterministic excerpt the server uses for replays, so
it can contain anything the conversation did. Treat the program as trusted code
on your host, and treat its note as untrusted text.

## A minimal hook

```js
#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";

const event = JSON.parse(readFileSync(0, "utf8"));
appendFileSync("/var/lib/omb/handoffs.ndjson", JSON.stringify(event) + "\n");
process.stdout.write(JSON.stringify({ text: `Continuing from ${event.from}.\n${event.summary}` }));
```

A real hook would write to a memory store and return what that store holds for
the conversation, so the backup resumes with durable context rather than an
excerpt.

## Checks

```sh
pnpm exec vitest run server/account-handoff.test.ts
pnpm exec vitest run server/limit-reset.e2e.test.ts --maxWorkers=1
```
