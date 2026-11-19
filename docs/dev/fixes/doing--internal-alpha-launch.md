---
status: doing
created: 2026-11-19
updated: 2026-11-19
scope: internal alpha launch
owner: Yv
related: []
---

# Prepare Gérer Build Studio for internal alpha

Execution checklist for [the detailed implementation plan](../plans/implementation--internal-alpha-launch.md). Esoe approved implementation on 2026-11-19. Yv owns integration and release, with SoSo and Z invited to review.

## Baseline and design

- [?] Record baseline checks, targets, version policy, existing related work, and isolated QA setup — `package.json:1`, `electron-builder.yml:1`.
- [?] Disable alpha update paths across startup, IPC, Settings and packaging — `electron/main.mjs:343`, `electron/updater.mjs:1`, `src/components/SettingsScreen.tsx:417`.
- [?] Specify shared UI, complete onboarding states, copy, and keyboard interaction rules — `src/components/Onboarding.tsx:122`, `src/components/Composer.tsx:540`.

## Onboarding and personalization

- [?] Build animated welcome with exact alpha product label — `src/components/Onboarding.tsx:122`.
- [?] Preserve/validate profile and recover from save failure — `src/components/Onboarding.tsx:135`.
- [?] Show truthful installation, sign-in, readiness and plan metadata — `src/lib/onboardingCopy.ts:1`.
- [?] Add purpose/custom-goal selection and editable, explained team proposal — `src/components/Onboarding.tsx:122`, `server/default-bots.ts:15`.
- [?] Apply approved teams safely with idempotency and existing-user preservation — `server/default-bots.ts:15`, `server/instances-default-fleet.test.ts:1`.
- [?] Add optional restartable tour and first useful action — `src/App.tsx:136`.

## Daily workflows

- [~] Verify browser-like web navigation on all relevant Preview surfaces — `src/components/PreviewFrame.tsx:82`, `src/components/PreviewScreen.tsx:57`.
- [?] Resolve authorized Markdown images with safe local paths and error states — `src/components/DocumentView.tsx:1`, `src/components/ChatMarkdown.tsx:1`.
- [?] Add per-conversation prompt history with draft restoration and caret/autocomplete priority — `src/components/Composer.tsx:540`, `src/lib/composerDrafts.ts:29`.
- [?] Add project-scoped file/folder autocomplete for / and ./ — `src/components/Composer.tsx:23`.
- [?] Unify app screens and improve schedules without regressing execution — `src/components/SchedulesScreen.tsx:8`, `src/components/SettingsScreen.tsx:762`.

## Release

- [?] Perform scoped folder cleanup and update affected imports/build paths — `package.json:1`, `electron-builder.yml:1`.
- [~] Rewrite README and guides with real candidate screenshots and exact developer commands — `README.md:1`, `docs/dev/RELEASING.md:1`.
- [~] Complete automated checks and independent responsive/Electron regression review — `package.json:1`.
- [~] Build and install-test target artifacts; record signing state and checksums — `electron-builder.yml:1`.
- [~] Review final staged contents, commit, push agreed source branch, and hand over evidence. Public release publication is separate.

## Verification notes

- Baseline on Node 24.19.0: 548 of 550 tests passed. Two schedule retry tests depended on elapsed timestamps in the simulated Codex account response. The fixture now generates a current window; all 556 tests in 71 files passed after the fix.
- The package version is 0.1.16. The installer target is macOS arm64. Windows packaging remains available for a separate Windows verification pass.
