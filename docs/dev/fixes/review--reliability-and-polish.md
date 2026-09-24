---
status: review
created: 2026-09-24
updated: 2026-09-24
scope: reliability and polish
owner: assistant
related: [review--harness-server-security.md, doing--release-distribution-ownership.md]
---

# Harden persistence, lifecycle, and cross-platform behaviour

Pre-release audit (2026-09-24). Baseline: `pnpm typecheck` passes, `pnpm test` passes 261/261 across 31 files, and `pnpm audit --prod` reports no known vulnerabilities. The items below are correctness and quality issues that the tests do not cover. None of them is a security blocker.

---

## 1. Data durability

- [?] **Write store files atomically** — `server/store.ts:206`, `server/store.ts:211`, `server/store.ts:311`. `writeFileSync` straight onto `bots.json`, `groups.json`, and message files can truncate them on a crash or power loss. The loader (`server/store.ts:188`) then silently falls back to `[]`, and the next save permanently erases every bot or room. Write to `*.tmp`, then `fs.renameSync`.
  - *Implemented:* `server/json-file.ts` (temp file then rename, retry on Windows). Commit `863c624`.
- [?] **Don't wipe config on a corrupt read** — `server/config.ts:63`. If `config.json` fails to parse, `saveConfig` starts from `{}` and overwrites every stored key. Back up the corrupt file (`config.json.bad-<ts>`) and surface an error. Apply the same approach in `server/store.ts:189`.
  - *Implemented:* A corrupt file is kept as `*.corrupt-<ts>` and logged. Commit `863c624`.

## 2. Composio change currently in the working tree

- [?] **Keep Composio off the turn's critical path** — `server/index.ts:529`, `server/index.ts:711`. `formatConnectedAppsPrompt` runs two sequential Composio calls (30 s timeout each, `server/composio.ts:42`) before every turn when the cache is cold. A slow or down Composio can delay the agent's first token by up to 60 s. Failures are not cached, so every turn retries. Cache failures briefly, cap this call at around 3 s, or refresh in the background.
  - *Implemented:* 3 s budget, shared in-flight lookup, failures cached 45 s. Commit `d5c0a0b`.
- [?] **Deduplicate integration assembly** — `server/index.ts:691`. The new `runGroupMemberTurn` block copies the computer and Composio integration logic from `startTurn`. Extract a `buildIntegrations(bot, instance)` helper so 1:1 and room turns cannot drift apart.
  - *Implemented:* `computerAndAppIntegrations` and `computerPromptHint`. Commit `d5c0a0b`.

## 3. Electron lifecycle and platforms

- [?] **Add a single-instance lock** — `electron/main.mjs:270`. A second launch starts a second server on a fallback port against the same `~/.gbs`, so two writers race on the same JSON files. Use `app.requestSingleInstanceLock()` and focus the existing window instead.
  - *Implemented:* Commit `e3e9d03`.
- [?] **Use `app.getPath("logs")`** — `electron/main.mjs:32`. The log directory is hard-coded to `~/Library/Logs`, which is wrong on Windows. AGENTS.md requires portability.
  - *Implemented:* Commit `e3e9d03`.
- [?] **Guard macOS-only IPC** — `electron/main.mjs:253`. `perm:open-settings` opens an `x-apple.systempreferences:` URL on Windows. Return early or map it to `ms-settings:privacy-microphone`.
  - *Implemented:* Windows maps to `ms-settings:` panes; other platforms do nothing. Commit `e3e9d03`.
- [?] **Guard CUA startup on non-macOS** — `electron/cua.mjs:7`. Paths are macOS-specific. Skip `startCua()` behind `process.platform === "darwin"` so Windows doesn't log a failure on every launch.
  - *Implemented:* `startCua()` runs on darwin only. Commit `e3e9d03`.
- [?] **Wait for the server child to exit on quit** — `electron/main.mjs:309`. `serverProc.kill()` is fire-and-forget, so in-flight store writes can be cut off. Send a graceful signal, wait for `exit` (with a short timeout), then quit.
  - *Implemented:* `stopServer()` waits up to 3 s. Commit `e3e9d03`.

## 4. Bundle size

- [?] **Restrict Shiki languages** — `src/components/ChatMarkdown.tsx:35`. The dynamic `import("shiki")` bundles about 300 grammar chunks (for example `emacs-lisp` 790 KB, `cpp` 785 KB, `wasm` 622 KB), so `dist/` is 11 MB. Use `shiki/core` with a curated set of languages (ts/js/tsx/json/bash/python/go/rust/css/html/md/yaml/sql/diff) and fall back to plain text.
  - *Implemented:* `src/lib/highlighter.ts`: 24 languages, JS regex engine. `dist/` went from 11 MB to 2.5 MB. Commit `6f550a7`.
- [?] **Split the 949 KB main chunk** — `src/components/CursorAvatar.tsx`, `src/components/SettingsScreen.tsx`, `src/components/AppsScreen.tsx`. Lazy-load the non-chat screens with `React.lazy` to speed up first paint.
  - *Implemented:* Settings, Apps, and Projects are lazy. The main chunk is now 640 KB. TaskBoardScreen stays eager because TasksPanel imports it. Commit `6f550a7`.
