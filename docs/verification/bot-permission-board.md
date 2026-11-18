# Bot service and MCP permission board

Settings → **You and your bots → Bot services & MCP permissions** is an
admin-only card on the Advanced **You and your bots** page. Rows are visible
bots with their departments and an allowed-count; columns are the current
account's connected services, native email when connected, and registered MCP
servers, grouped under Services and MCP band headers. Bot and resource search
and a service/MCP filter change only the view, never grants. Settings search
finds the card (`permissions`, `mcp`, …) and turns Advanced on when needed.

## Automated qualification

```sh
pnpm exec vitest run src/lib/bot-permission-board.test.ts src/components/BotPermissionBoard.dom.test.ts server/settings-permissions-matrix.e2e.test.ts
node --experimental-strip-types scripts/gen-settings-places.ts
node --experimental-strip-types scripts/verify-bot-permissions.mjs
```

All mutations use disposable fake-engine server data. No live bot, private
account, real service credential or external model is needed. The Electron
smoke mounts the real Settings window, production store and board through
Vite; its network allowlist permits only the local preview and fixture server.
It does not load the packaged app or production preload.

The smoke verifies:

- Advanced page navigation away and back through the Settings nav, and reaching
  the board from Simple mode through Settings search, which turns Advanced on.
- Initial per-bot cells, a globally disabled MCP cell, independent two-bot
  service/MCP changes with successful-save feedback.
- Real `PATCH /api/bots/:id`, fresh HTTP reads and durable fixture `bots.json`.
- Exact-tool grants retained; explicit MCP lists persist across a reload.
- Bot/resource search, the MCP-only filter, Japanese render and 390px layout.
- Horizontal matrix scrolling confined to its region; sticky Bot column and
  headers; no horizontal document overflow or external requests.

It prints an evidence directory containing `receipt.json`, `electron.log` and
screenshots. Its temporary profile and fake server are removed afterwards.

The HTTP integration test also runs fake turns and invokes the real internal
connector gate against a loopback stand-in: withheld, excluded-todo and write
operations on read-only apps are denied, an immediate app revocation blocks
further calls, and a bot with services globally off starts with only the newly
selected app granted. MCP narrowing persists while a bot works: changes apply
from a bot's next turn, as the row's line says; the widening-409 an originless
local caller gets while any bot works stays the server's own policy and is not
re-tested here.

## Permission semantics

- Every edit reads a fresh bot snapshot before deriving a minimal permission
  patch, and waits for the server's response before showing a changed check.
  A per-bot synchronous in-flight guard prevents lost compound grants from
  simultaneous cells; other bots can still be edited.
- Services reuse `botAppScope` and `appSwitchPatch`. Existing read-only scopes
  and exact-tool restrictions are retained. An app newly switched on receives
  normal **write** scope; switching a read-only app off and back on also grants
  write, still subject to any retained exact-tool list. Unknown grant formats
  are read-only. A bot with services globally off starts with only the newly
  selected app granted, never every connected one.
- A missing MCP list inherits the effective eligible servers; its first edit
  materializes an explicit selection that keeps granted (even globally
  disabled) servers and excludes another bot's servers. A list never enables
  a globally disabled server. Globally disabled and foreign-owned cells are
  read-only; tool-scope ceilings remain enforced elsewhere.
- `offFor` is connection health, not permission: its warning shows without
  blocking revocation. A busy bot stays editable; its row shows the standard
  next-turn line.
- Inventory failures disable the affected edits rather than treating unknown
  state as an empty list; Refresh retries without clearing grants. Native
  email has its own connection-status check.
- The board manages the server's **bot-side ceiling**, not credential sharing.
  It does not combine members' private app inventories, bypass
  private-audience rules, or control independent connections installed inside
  an external CLI. Computer, filesystem and model-native tool permissions
  remain separate.
