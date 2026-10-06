# omp (oh-my-pi)

[omp](https://github.com/can1357/oh-my-pi) is an optional OpenMausBot engine,
a fork of upstream pi distributed as `@oh-my-pi/pi-coding-agent`. Its native
driver uses `omp --mode rpc-ui`, not ACP or pi's RPC protocol.

## Setup

1. Install omp on macOS or Linux:
   ```sh
   curl -fsSL https://omp.sh/install | sh
   ```
   On Windows (PowerShell 5.1 or newer, x64 or arm64):
   ```powershell
   irm https://omp.sh/install.ps1 | iex
   ```
   Restart the terminal after installation if the installer updated `PATH`.
   Homebrew, Bun and Nix installs are listed in the [omp README](https://github.com/can1357/oh-my-pi#install).
2. Sign in with `omp login`.
3. Restart OpenMausBot and choose **omp** in the model picker.

Requires **omp 18.4.9 or newer**: 18.3.1 added the terminal prompt status,
`sessionSettled` flag and `session_settled` event; 18.4.9 added `set_ask_dialog`,
whole-question `ask` answers and expired-dialog cancellation notifications.
The driver relies on all of these, not just the older `agentInvoked` flag.
An older CLI is reported unavailable with its update command. When npm publishes
a newer stable `@oh-my-pi/pi-coding-agent`,
Engines and the model picker show an update notice whose command runs the
configured executable's own `omp update`, so an omp outside `PATH` is updated in
place. Credentials stay in omp; OpenMausBot strips provider API-key environment
variables from the child process, as it does for pi.

The default instance is `omp`. To override its executable in local configuration:

```json
{"instances":{"omp":{"driver":"ompAgent","config":{"cli":"omp"}}}}
```

`cli` may also be an absolute path. Additional `ompAgent` instances are supported.

## Models

The picker reads omp's own catalog through `get_available_models`. Its default
is omp's current default model. **Refresh models** runs `omp models refresh`.
Live local hosts (oMLX, Ollama, EXO, LM Studio and Unsloth) are registered for the
turn through the extension's `registerProvider`; OpenMausBot never edits
`~/.omp/agent/models.yml`. Per-turn usage includes cache reads and omp's computed cost.
A successful empty refresh clears revoked omp models and sign-in status, while
live local hosts remain available. A failed probe keeps the last omp catalog.
Every catalog probe and turn negotiates RPC protocol v2 and waits for its
acknowledgement before sending commands, preserving large catalogs and turn
frames through lossless chunk reassembly. Invalid chunks and transport overflow
are reported as failures instead of empty catalogs or missing output.

## Approvals

| OpenMausBot level | omp mode |
| --- | --- |
| Ask for approval | `--approval-mode always-ask`: reads auto-approved; writes and shell commands ask |
| Auto-accept edits | `--approval-mode write`: reads and file edits auto-approved; shell commands ask |
| Approve for me | `always-ask`: omp has no automatic reviewer |
| Full access | `--approval-mode yolo`; OpenMausBot answers residual permission prompts, including provider safety checks and host-computer actions |

Custom is not offered. Approvals appear as OpenMausBot permission cards; a shell
approval carries the exact command, so a saved command permission can answer it.
See [Approval levels](approval-levels.md) for Full access grants and their boundaries.

## Questions

omp's `ask` tool becomes one OpenMausBot question card with up to **6 questions**
with distinct ids. A set that cannot be shown whole is declined with a notice,
never answered in part. Answers make a structured round-trip through the rpc-ui
dialog; free text is always possible. No approval level answers these questions
for you. A card's 15-minute deadline cancels the question or denies the approval;
it never chooses omp's recommended answers.

## Tools and MCP

omp supports both native and MCP [tool selection](./tool-selection.md). Native
names include `read`, `edit`, `write`, `bash`, `grep` and `glob`. The OpenMausBot
extension restricts active tools using the same mechanism as pi.

Agents, connected apps, browser, computers, phone and custom MCP servers mount
through the extension (`-e`) as top-level tools, not behind omp's `xd://` devices.
omp's own MCP configuration (`.mcp.json` and `~/.omp/agent/mcp.json`) keeps
loading natively. Tool selection narrows availability; it is not a filesystem
or shell sandbox.

## Sessions

OpenMausBot starts one rpc-ui process per turn. Conversations persist in omp's
own session store (`~/.omp/agent/sessions`, respecting `PI_CODING_AGENT_DIR` and
profiles), and resume with `switch_session`. A cancelled switch or a different
`get_state.sessionFile` is a refused resume, just like a missing session file:
OpenMausBot rebuilds from its transcript or fails rather than starting blank.
A queued turn waits for its predecessor's process to close and flush the session
before opening it. Stop ignores later frames; shutdown kills owned process trees
without relying on a delayed timer. Mid-turn messages steer through `steer`.

Turn completion follows `prompt_result`. Whenever `sessionSettled` is false,
OpenMausBot waits for `session_settled`, including failed and aborted prompts, so
late background work is not lost. Ordinary command and catalog deadlines match
the reference client's 30 seconds; prompt admission allows 120 seconds.

## Compaction

omp compacts its own session in place, following its `compaction.*` settings
(`omp config list | grep compaction`; change them with `omp config set`).
OpenMausBot never folds an omp conversation automatically: its own automatic
compaction starts a new native session from a summary, which would throw
away what omp keeps across its own compaction. `context.autoCompact` and
`context.compactAt` therefore do not affect omp threads. An explicit
compaction request from the person (`POST /api/bots/:id/compact`) still runs.
When omp reports `auto_compaction_start/end`, or a slash command completes
locally (including manual `/compact`, which emits no compaction lifecycle event),
the next turn sends the full standing instructions again. A local command never
establishes a receipt for instructions the agent did not receive.

## Testing

`server/drivers/omp.test.ts` runs the driver against the scripted fake CLI in
`server/testing/fake-omp-cli.ts`; no omp install or account is needed. The
OpenMausBot extension is shared with pi, so `server/drivers/pi-mcp-extension.test.ts`
covers it for both engines.

The driver's consumed command, response and event fields are checked against
omp **18.5.1**'s generated `rpc-wire.schema.json` and TypeScript wire definitions.
Transport contracts cover v2 negotiation, large UTF-8 frames, corrupt chunk
sequences and overflow failures against the dependency-free fake CLI.
