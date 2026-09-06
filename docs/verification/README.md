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
- [Team backups](team-backups.md)

Renderer-only behavior—Settings, sidebar drag-and-drop, the VM modal, the
built-in browser panel, and updater UI—is not proven by this first harness.
Use the relevant Electron/package smoke test and state that limitation. Add a
map entry only after the shared control surface can really drive it.

The [cloud preview fixture](cloud-preview.md) mounts the real Computer panel
against an isolated server for image decoding, loading, and recovery UI checks.

The [bot settings fixture](bot-settings.md) checks profile saves, standing
instructions, history restore, skill/memory refresh, and stale-response isolation.

## Evidence

Keep the JSON from `wait` and `messages`, the exact command sequence, and the
fixture's printed log path. Evidence must show both the action and the resulting
state. A green unit test alone does not prove a user workflow.

## Cleanup

Interrupt the `launch` process with Ctrl-C. It stops the exact child it owns and
removes only its temporary data directory. The server log remains at the
printed path. Never kill processes by name and never delete a broad temp root.
