---
status: review
created: 2026-11-19
updated: 2026-11-19
scope: curated apps and Edits integration
owner: Yv (CEO bot)
related: []
---

# Replace Composio with curated apps, starting with Edits

Remove the Composio integration and replace it with curated, non-technical apps on the Apps screen, starting with Edits (local MCP automation server). Covers the app registry, live status checks, setup popup, Buddy app routing (use / explain setup / ask which / `+app` tag), and composer app tags. Plan: `docs/dev/plans/implementation--curated-apps-and-edits.md` (approved 2026-11-19). Other apps, OAuth cloud apps and per-Buddy app permissions are not covered.

---

## 1. Remove Composio

- [?] **Delete the Composio server module and tests** — `server/composio.ts:1`. Composio needs a developer account and keys, and testing showed it only reached Claude Buddies.
- [?] **Remove Composio config, routes, prompt text and turn integration** — `server/config.ts:19`, `server/index.ts:528`, `server/index.ts:772`, `server/index.ts:977`, `server/index.ts:2462`, `server/contracts.ts:120`, `server/drivers/claude.ts:263`. No Buddy should be told about tools it doesn't have.
- [?] **Remove the Composio key fields and store flags** — `src/components/ApiKeys.tsx:9`, `src/components/SettingsScreen.tsx:234`, `src/state/store.tsx:164`.
- [?] **Update the user-facing docs** — `README.md`, `SECURITY.md`, `docs/guide/glossary.md`, `docs/guide/copy-sweep.md`, `.github/ISSUE_TEMPLATE/`.

## 2. App registry, storage and status

- [?] **Add the curated catalog with an Edits entry** — `server/apps/catalog.ts` (new). Plain-language setup steps, capabilities, default endpoint `http://127.0.0.1:19501/mcp`, Bearer token auth.
- [?] **Add per-app settings with write-only, owner-only token storage** — `server/apps/store.ts` (new). Loopback-only endpoints.
- [?] **Add live health checks (Not running / Needs setup / Ready / Error)** — `server/apps/health.ts` (new). Uses MCP `initialize` + `tools/list` with a 5 s timeout.
- [?] **Add app routes (list, save, test, disconnect, internal forward)** — `server/index.ts`.

## 3. Buddies use apps

- [?] **Expose `list_apps` and `use_app` through the harness proxy** — `server/drivers/agents-proxy.ts:25`. Reaches Claude, Codex and ACP Buddies, and the token stays in the harness.
- [?] **Add the Apps prompt section only for MCP-capable drivers** — `server/apps/prompt.ts` (new), `server/index.ts:772`, `server/index.ts:977`. Rules: use if Ready, explain setup if not, ask when more than one app fits, a `+app` tag wins.

## 4. Apps screen and composer

- [?] **Rewrite the Apps screen around curated apps with status pills** — `src/components/AppsScreen.tsx:1`.
- [?] **Add the app setup popup with Test connection** — `src/components/AppSetupDialog.tsx` (new).
- [?] **Show which models can use each app (provider tags on cards, popup and picker)** — `src/components/AppsScreen.tsx`, `server/index.ts`. Derived from each instance's `capabilities.agentsMcp`.
- [?] **Add `+app` tags in the composer and chips in message bubbles** — `src/lib/appMentions.ts` (new), `src/components/Composer.tsx:80`.

## 5. Verification

- [?] **Automated tests for removal, store, health, proxy, prompt and tag parsing** — `server/apps/*.test.ts`, `src/lib/appMentions.test.ts`.
- [?] **Live QA with the real Edits app in an isolated second Electron instance** — follow the manual scenarios in the plan, using `TEST ·` names.

## QA notes (2026-11-19)

- Isolated desktop instance (harness 8977, Vite 5388, throwaway profile and data dir), real Edits app. Wrong token → readable warning; real token → **Ready, 32 actions**; token stored only in `apps.json` and never returned by `/api/apps`.
- Claude Buddy (Yv), `+edits` picked from the composer: called `list_apps` and `use_app` (`appState`, `newProject`, `renameProject`, `addMedia` ×4, `projects`) and built **TEST · montage** with clips 1–3 in order. It reported a failed import honestly.
- Finding: Edits is sandboxed to `~/Movies`. Now taught to Buddies via catalog `buddyNotes` (commit `abe5a86`). The test copied clips into `~/Movies/TEST · montage clips/` on the real machine.
- Antigravity Buddy: the picker warns that the model can't use apps. The Apps prompt gating reuses the existing `integrations.agents` check (no harness-level test exists for prompt gating).
- Not run live: the "app not set up" conversation (covered by unit tests) and a Codex Buddy turn (Claude usage was at 10%).
- `pnpm test`: 543 passed, 2 failed in `server/schedules-runtime.test.ts`. Both fail identically on `main` and are unrelated.


## User-requested follow-ups (2026-11-19)

- [?] Bundle the actual Edits desktop app icon and use it in the catalog UI — `public/apps/edits.png`, `server/apps/catalog.ts`, `src/components/AppsScreen.tsx`.
- [?] Show Allow / Deny / Always allow on tool approval cards. Remember the choice per Buddy and tool, with removal in Buddy settings — `server/index.ts`, `server/room-activity.test.ts`, `src/components/SettingsPanel.tsx`.
- [?] Remove Trello settings, linking UI, API routes, polling, client modules, task-card fields, sync script, and setup docs. Remove legacy credentials and links at load; preserve tasks and historical attribution — `server/config.ts`, `server/tasks.ts`, `server/index.ts`, `src/components/TaskBoardScreen.tsx`.
- [?] Validate and merge into main under the user's explicit instruction to do the fixes and merge independently.

Follow-up validation: production build and typecheck pass. Full suite: 523 passed, 2 failed (the same two previously established schedule recovery failures). After adding removed-route assertions, focused API/config tests: 36 passed. Existing room-activity tests cover approval option order, remembered tool approval, and revocation. Studio Preview at 1440×900 against fresh disposable data on port 8978: actual Edits icon loads, Needs setup state shown, Task Board has no Trello control, Connections has only xAI. No new console/network errors on that origin; earlier port-5388 checks encountered an invalid stale QA project registry, so validation moved to a fresh isolated registry. No real AI turns or Trello requests performed for these follow-ups.
