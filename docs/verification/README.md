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
untouched.

Pass the printed URL explicitly from a second terminal:

```sh
pnpm control:omb doctor --url http://127.0.0.1:PORT
```

Mutating commands refuse silent port discovery. This prevents a verification
recipe from sending messages to the user's running app by accident.

## Drive

Use only mapped, tested commands:

- [Chat turns](chat-turns.md)
- [Channels](channels.md)
- [Engines and Doctor](engines.md)
- [Qwen model route selection](qwen-models.md)
- [Team backups](team-backups.md)

Renderer-only behavior—Settings, sidebar drag-and-drop, the VM modal, the
built-in browser panel, and updater UI—is not proven by this first harness.
Use the relevant Electron/package smoke test and state that limitation. Add a
map entry only after the shared control surface can really drive it.

The [cloud preview fixture](cloud-preview.md) mounts the real Computer panel
against an isolated server for image decoding, loading, and recovery UI checks.

The [live browser fixture](browser-live.md) mounts the real Browser panel with
an explicitly selected native engine and Chrome in a disposable home, covering
watching, takeover, input, and profile switching.

The [bot settings fixture](bot-settings.md) checks profile saves, standing
instructions, history restore, skill/memory refresh, and stale-response isolation.

The [avatar provider fixture](avatar-providers.md) checks image-provider settings,
keyless local generation, saved-key handling, and safe errors with a local fake API.

The [independent threads fixture](threads.md) checks nested sidebar navigation,
per-thread models, simultaneous direct conversations and thread-scoped Stop.

The [right-to-left fixture](bidi.md) checks per-block direction in bot replies
and per-line direction in sent turns, with code pinned left-to-right.

The [routines fixture](routines.md) checks confirmed proposals, manual and
scheduled runs, central run logs, List/Calendar views, and bot-scoped routines
using the real renderer and an isolated fake-engine server.

The [server settings recipe](server-settings.md) checks browser provider sign-in
with an offline CLI and custom-domain validation without touching live accounts.

The [engine library fixture](engines-ui.md) checks onboarding and Settings cards,
responsive layouts, theme contrast, and status refreshes without losing drafts.

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

Keep the JSON from `wait` and `messages`, the exact command sequence, and the
fixture's printed log path. Evidence must show both the action and the resulting
state. A green unit test alone does not prove a user workflow.

## Cleanup

Interrupt the `launch` process with Ctrl-C. It stops the exact child it owns and
removes only its temporary data directory. The server log remains at the
printed path. Never kill processes by name and never delete a broad temp root.
