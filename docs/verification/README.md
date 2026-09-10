# Verifying OpenMausBot

OpenMausBot has one development control surface: `pnpm control:omb`. It is a
thin command-line adapter over `scripts/mcp-server.ts`, so verification uses
the same URL validation, task pinning, bounded transcripts, wait states, and
redaction as external MCP clients.

## Launch

Start a fixture in one terminal:

```sh
node --experimental-strip-types scripts/control-omb.ts launch
```

Run the foreground launcher directly rather than through `pnpm`; this ensures
it receives Ctrl-C and can stop its child before removing the temporary data.

It gives the child a temporary data directory and home, chooses a free
harness/webhook port pair, installs only the repository's fake engine, prints
the URL, PID, data directory, and persistent log path, then stays attached to
that exact child. The parent shell and the user's OpenMausBot data are
untouched. Only `FAKE_CLAUDE_*` variables cross from the launcher's
environment into that child, so a recipe can script the fake engine's mode,
replies and tool calls without writing a wrapper CLI.

Pass the printed URL explicitly from a second terminal:

```sh
pnpm control:omb doctor --url http://127.0.0.1:PORT
```

Mutating commands refuse silent port discovery. This prevents a verification
recipe from sending messages to the user's running app by accident.

## Drive

Use only mapped, tested commands:

- [Chat turns](chat-turns.md)
- [Chat UI, driven headlessly](chat-ui.md)
- [Channels](channels.md)
- [Engines and Doctor](engines.md)
- [Claude coordination and turn-scoped tools](claude-tool-lifecycle.md)
- [Codex bot instructions](codex-instructions.md)
- [Qwen model route selection](qwen-models.md)
- [Team backups](team-backups.md)
- [Usage ledger](usage-ledger.md)
- [Spend cap and sell prices](spend-cap.md)

`control-omb ui` ([Chat UI, driven headlessly](chat-ui.md)) drives the real
renderer in a headless Chrome by accessible name, so composer sends, transcript
rows, tool chips and server feature flags are provable from the command line.
Other renderer-only behavior—Settings, sidebar drag-and-drop, the VM modal, the
built-in browser panel, and updater UI—is still not proven by the harness. Use
the relevant Electron/package smoke test and state that limitation. Add a map
entry only after the shared control surface can really drive it.

The [desktop server connection smoke](desktop-server-connection.md) mounts the
real Settings connection component in disposable Electron windows.

The [cloud preview fixture](cloud-preview.md) mounts the real Computer panel
against an isolated server for image decoding, loading, and recovery UI checks.

The [live browser fixture](browser-live.md) mounts the real Browser panel with
an explicitly selected native engine and Chrome in a disposable home, covering
watching, takeover, input, and profile switching.

The [bot settings fixture](bot-settings.md) checks profile saves, standing
instructions, history restore, skill/memory refresh, and stale-response isolation.

The [sidebar fixture](sidebar.md) checks archive and delete confirmations, their
default focus, keyboard wrapping and focus return against two disposable bots.

The [avatar provider fixture](avatar-providers.md) checks image-provider settings,
keyless local generation, saved-key handling, and safe errors with a local fake API.

The [independent threads fixture](threads.md) checks nested sidebar navigation,
per-thread models, simultaneous direct conversations and thread-scoped Stop.

The [right-to-left fixture](bidi.md) checks per-block direction in bot replies
and per-line direction in sent turns, with code pinned left-to-right.

The [routines fixture](routines.md) checks confirmed proposals, manual and
scheduled runs, central run logs, List/Calendar views, and bot-scoped routines
using the real renderer and an isolated fake-engine server.

The [interval restrictions recipe](interval-restrictions.md) checks weekday and
time-window limits on scheduled routines in that same disposable fixture.

The [server settings recipe](server-settings.md) checks browser provider sign-in
with an offline CLI and custom-domain validation without touching live accounts.

The [engine library fixture](engines-ui.md) checks onboarding and Settings cards,
responsive layouts, theme contrast, and status refreshes without losing drafts.

The [Claude account recipe](claude-account.md) checks sign-out, cancellation and
retry against an offline Claude CLI confined to a disposable home.

The [Codex account recipe](codex-account.md) checks account switching against an
offline Codex CLI whose identity is synthetic and whose credential directory is empty.

The [mention fixture](mentions.md) checks candidate selection, composer highlighting,
sent mentions, multiline scrolling and responsive wrapping in real chat views.

The [Group and Goal Local VM recipe](group-local-vm.md) checks per-speaker
desktop routing, cancellation, and computer authority cleanup.

## Evidence

The [Japanese desktop font recipe](japanese-desktop.md) checks real Firefox and
XFCE glyph rendering in disposable managed desktops, including fresh recreation.

The optional [Podman full-stack acceptance recipe](podman-self-hosting.md)
checks the Compose deployment with a fresh home, fake engine, and two desktops.
It includes workspace ownership, persistence, and proxy authentication checks.

The [Podman Firefox sandbox recipe](podman-firefox.md) checks the capability set a
managed desktop keeps so Firefox can start, with before/after acceptance evidence.

The [Hetzner launch record](hetzner-launch-2026-09-07.md) is a dated self-hosting
run on a disposable VPS: what passed, what was corrected, and what it does not prove.

Keep the JSON from `wait` and `messages`, the exact command sequence, and the
fixture's printed log path. Evidence must show both the action and the resulting
state. A green unit test alone does not prove a user workflow.

## Cleanup

Interrupt the `launch` process with Ctrl-C. It stops the exact child it owns and
removes only its temporary data directory. The server log remains at the
printed path. Never kill processes by name and never delete a broad temp root.
