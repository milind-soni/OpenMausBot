# Implementation plan: remove the cloud computer integration

## Objective

Completely remove the "cloud computer" feature: Box sandboxes from
box.ascii.dev, the Box token, the box-hosted "Computer" engine, and the
cloud parts of the Computer panel. Bots keep the ability to use **this
computer** (local computer use through CUA in the desktop app), and they keep
the ability to have no computer at all.

Out of scope: local computer use (`electron/cua.mjs`) and Composio connected
apps. Both stay.

## Current state

- `server/box.ts` (232 lines) talks to the Box API: find, provision, join,
  sleep, exec, and screenshot.
- `server/drivers/boxagent.ts` (244 lines) is an engine that runs turns *on*
  the box (`driverKind === "boxAgent"`).
- `server/computer-proxy.ts` (273 lines) is the MCP bridge that gives Claude
  screenshot, exec, and open-url on the box. It is wired in
  `server/drivers/claude.ts:9-10,58,278` through `GBS_BOX_TOKEN`.
- `server/index.ts`:
  - imports box (`:12`)
  - live-screen poller (`:278-305`)
  - computer resolution and provisioning per turn (`:420-450`, `:535`)
  - `box.configured` in config frames (`:864`, `:1684`)
  - box REST routes (`:1789-1809`)
- `server/contracts.ts:116`: `integrations.computer` is described as the box.
- `server/store.ts:109-111` and `src/state/store.tsx:106-107,146,1174`:
  - `bot.computer?: "cloud" | "local" | "off"`
  - `config.box`
- UI:
  - `src/components/ComputerPanel.tsx`: the cloud flow, the token prompt, and
    the "Cloud box" option.
  - `src/components/SettingsPanel.tsx:168`: the cloud/local/off picker.
  - `src/components/SettingsScreen.tsx:254-259`: the "Box Cloud Token" field.
- `scripts/e2e-server.mjs`: the `--with-box` e2e path.
- Drivers `codex.ts` and `antigravity.ts` reference the computer integration.
  Audit each during implementation.

## Proposed changes

1. Delete `server/box.ts`, `server/drivers/boxagent.ts`, and
   `server/computer-proxy.ts`. Remove the boxAgent registration from the
   driver and instance registry. Remove the proxy wiring in `claude.ts`.
2. In `server/index.ts`:
   - Remove the box routes, the screen poller, the provisioning path, and
     `box` in config frames.
   - Computer resolution becomes: `off` → none; otherwise local CUA when the
     desktop bridge is available.
3. Data migration:
   - When `bots.json` loads, `computer: "cloud"` is rewritten to unset (auto =
     local when available).
   - `config.box` is dropped on the next atomic config write.
   - A bot whose model selection points at a boxAgent instance falls back to
     the default selection, with a one-time notice in its chat: "This bot used
     the cloud computer, which has been removed. It now uses <model>."
4. Narrow the types:
   - `computer?: "local" | "off"` in both stores.
   - Remove `config.box`.
   - Remove box fields from contracts.
5. UI:
   - `ComputerPanel` shows only this computer.
   - The Settings picker offers "This computer" and "Off".
   - Remove the Box token field and its copy.
   - Remove the `box` / `cloud` keyword heuristics in `AppsScreen.tsx:89-93`
     *only* if they exist for the box feature. Dropbox and other cloud apps
     must still match.
6. Remove `--with-box` from `scripts/e2e-server.mjs`.
7. Docs:
   - Remove Box from `README.md`, `SECURITY.md`, and any screenshots or
     settings docs.
   - Add a CHANGELOG/release note line.

Failure behavior: an old config or bot file with cloud fields must load
without error. Unknown fields are ignored and migrated.

## Verification

- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- New tests:
  - The store migrates `computer: "cloud"` and boxAgent selections.
  - Config loading ignores `box`.
- `grep -rni "box.ascii\|boxAgent\|GBS_BOX_TOKEN\|computer-proxy" src server electron scripts`
  returns nothing.
- Manual (Dell):
  - Upgrade a profile that had a Box token and a cloud bot. The app opens,
    the bot chats, and the notice appears once.
  - Local computer use still works in the desktop app.
  - The browser session shows no computer options it can't honor.

## Risks and rollback

- Users who relied on the cloud computer lose it. This is intentional and
  noted in the release notes.
- Hidden coupling in drivers. Mitigate with the grep check and the driver
  tests.
- Rollback: revert the removal commits. The data migration only drops fields,
  so a reverted build simply sees no Box token.

## Approval

Status: awaiting user approval (the removal itself was requested by the user on 2026-11-12)
