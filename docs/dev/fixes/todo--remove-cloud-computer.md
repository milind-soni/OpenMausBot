---
status: todo
created: 2026-11-12
updated: 2026-11-12
scope: remove cloud computer integration
owner: SoSo
related: [todo--preview-studio.md]
---

# Remove the cloud computer (Box) integration

Implements `docs/dev/plans/implementation--remove-cloud-computer.md`. Removes Box sandboxes, the Box token, and the box-hosted Computer engine. Local computer use and Composio stay. Starts after plan approval.

---

## 1. Server

- [ ] **Delete Box modules** — `server/box.ts`, `server/drivers/boxagent.ts`, `server/computer-proxy.ts`. Also remove the boxAgent registration and the Claude proxy wiring at `server/drivers/claude.ts:58,278`.
- [ ] **Strip Box from the harness** — `server/index.ts:12,278-305,420-450,864,1684,1789-1809`. Remove the routes, the screen poller, provisioning, and the config flag.
- [ ] **Migrate stored data** — `server/store.ts:111`, `server/config.ts`:
  - `computer: "cloud"` becomes unset.
  - boxAgent selections fall back to the default, with a one-time chat notice.
  - `config.box` is dropped.

## 2. App

- [ ] **Simplify the Computer panel** — `src/components/ComputerPanel.tsx`. Show this computer only.
- [ ] **Simplify Settings** — `src/components/SettingsPanel.tsx:168`, `src/components/SettingsScreen.tsx:254`. Offer "This computer" and "Off". Remove the Box token field.
- [ ] **Narrow types** — `src/state/store.tsx:107,146,1174`, `server/contracts.ts:116`.

## 3. Tooling and docs

- [ ] **Remove `--with-box` e2e path** — `scripts/e2e-server.mjs:4-25,218+`.
- [ ] **Update docs** — `README.md`, `SECURITY.md`, release notes.

## 4. Verification

- [ ] **Tests** — Add migration tests, and confirm the grep check for Box references finds nothing.
- [ ] **QA** — Dell: upgrade a profile that had a Box token and a cloud bot. Confirm local computer use still works.
