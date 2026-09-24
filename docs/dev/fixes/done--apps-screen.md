---
status: done
created: 2026-08-14
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: dedicated app store screen and rename plugins to apps
owner: esoefildine
related: []
---

# Rename plugins to apps and dedicated App Store screen

Replace the plugins modal panel with a dedicated, full-screen App Store experience (`AppsScreen.tsx`) and rename "Plugins" to "Apps" across UI and state.

---

## 1. State and Actions

- [x] **Update store state and actions** — `src/state/store.tsx:167`. Rename `pluginsOpen` to `appsOpen`, add `toggleApps`, and ensure screen toggling mutually excludes other full-screen views.
- [x] **Update store unit tests** — `src/lib/store.test.ts:183`. Test `toggleApps` and `appsOpen` state transitions.

## 2. Dedicated App Store Screen

- [x] **Create AppsScreen component** — `src/components/AppsScreen.tsx:1`. Implement full-screen App Store page with header, live search, category tabs, featured spotlight banner, responsive card grid, connection management (OAuth/disconnect), refresh, and keyboard shortcuts.
- [x] **Remove obsolete PluginsPanel** — `src/components/PluginsPanel.tsx:1`. Replace with `AppsScreen.tsx`.

## 3. Sidebar and App Shell Integration

- [x] **Update sidebar navigation** — `src/components/Sidebar.tsx:764`. Rename "Plugins" to "Apps", use `LayoutGrid` icon, and highlight active state when `state.appsOpen` is true.
- [x] **Integrate AppsScreen into main view** — `src/App.tsx:58`. Render `<AppsScreen />` as a main view alongside Settings, Task Board, and Projects screens.

---
