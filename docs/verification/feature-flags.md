# Feature discovery and skills enablement

Run the real Settings renderer against a disposable fake-engine server:

```sh
node --experimental-strip-types scripts/verify-feature-flags.ts
```

The script uses installed Chrome at `OMB_CHROME_PATH` (defaults to the Windows
Chrome installation). It creates a temporary browser profile inside the fixture,
then closes its browser, preview and server and removes only its fixture data.
It does not open the installed desktop app or change personal settings.

Assertions cover simple and advanced modes at 1280×900 and 390×844:

- Skills stays reachable while disabled, and does not fetch the library.
- A failed save shows an error and does not mount the library.
- Confirmed enablement mounts and fetches the library; disabling unmounts it.
- A synthetic imported skill and its bot assignment survive disable/enable.
- Searches for tool calls, recall, guard and tool bridge reveal their controls
  or explanatory documentation, including search on a narrow screen.
- A synthetic member session sees the administration explanation without the
  library switch.
- The narrow page has no horizontal document overflow.

Screenshots and `evidence.json` are written to `.omb-scratch/features`, or
`OMB_UI_EVIDENCE_DIR`. Inspect the screenshots for wrapping and control
visibility. The JSON records the isolated URL, data directory and retained log.

Related regression checks:

```sh
pnpm exec vitest run shared/features.test.ts src/lib/feature-flags.test.ts src/components/FeatureSettings.test.ts src/components/SettingsModal.search.test.ts src/components/SettingsModal.simple.test.ts src/components/SkillReviewSettings.test.ts server/skills-library-config.e2e.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
```

The server test also checks exhaustive feature status, partial updates and
persistence through restart. These are offline renderer/server checks; they do
not qualify live engines, microphone/computer permissions or packaged Electron.
