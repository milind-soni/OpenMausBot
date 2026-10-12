# Update everything

The local desktop's **Settings → General → Update everything** checks saved
environments, presents a plan, and asks for confirmation. It updates supported
installed providers first, then eligible remote desktop apps, then this app.
It never accepts an origin, executable or install command from the renderer.

## Scope and recovery

- Installed npm-backed providers and Claude use the existing installers.
  Custom npm executable paths and unsupported installers are shown as manual.
  Read-only/company-policy providers are not modified. Providers without a
  version-check API are updated through their installer, not advertised as
  definitely outdated.
- Remote requests use the saved origin and Electron's existing session cookies.
  The server requires a current administrator session and its own environment
  identity. Redirects are refused; remote responses are bounded.
- Desktop-managed apps use their own signed updater feed. Operator-managed
  servers and Linux package-manager handoffs are not restarted automatically.
  Inactive local environments must be selected separately to update providers.
- A maintenance lease refuses active work and gates new work while an installer
  runs. Background schedulers resume when that lease ends. Provider failure
  prevents subsequent restarts; a lost write response is never automatically
  retried. Already completed installs are not rolled back.
- Conversations and drafts retain their existing persistence. **This does not
  implement automatic continuation of interrupted direct turns.** Finish work
  and calls first. Do not describe this initial implementation as full T3
  restart-continuation parity.
- Plans expire after five minutes, are one-use, and bind the saved origin,
  environment identity, provider install target and downloaded app version.
  The native progress receipt survives app restart and verifies the expected
  local version; it contains no credentials or executable instructions and is
  never used to replay mutations.

## Automated checks (no real updates)

```sh
node --test electron/update-everything*.node-test.mjs
pnpm exec vitest run server/routes/updates.test.ts server/desktop-update-bridge.test.ts src/components/UpdateEverything.test.ts
```

The coordinator uses synthetic environments and installers. The HTTP fixture
binds an ephemeral loopback port with stub installers and a real maintenance
lease. It checks authorization, identity/version binding, overlapping requests,
lease release, and acknowledging a restart before closing the connection.
The React tests check confirmation, Escape/focus return, duplicate submission,
late progress responses and visible failure. They are DOM tests, not packaged
Electron acceptance. A host that denies `listen` cannot run the HTTP fixture;
that is a verification limitation, not a passing test or grounds to skip it.

## Packaged acceptance still required

Use disposable desktop profiles and fake providers only, following the main
verification README. Never connect the fixture to the user's real saved
environments or install/update a real CLI during this check. Verify the local
bridge, saved remote administrator cookie, narrow layout, reconnect/version
receipt and native restart using controlled signed test builds. A standalone
server reports operator-managed and must not be given automatic install
authority for this test. Ordinary `control-omb` cannot drive this updater UI;
its doctor result alone does not prove this update workflow.

Implementation reference: T3 Code nightly
`v0.0.46-nightly.20261012.3010`, commit
`d83929ad0bb0d4aec800f12c332de57e873cc7e5`, particularly
`apps/web/src/components/sidebar/useUpdateEverything.ts` and
`apps/server/src/orchestration-v2/RestartContinuation.ts`. This change reuses
MausBot's existing updater and maintenance lease; it does not port T3's
server launcher, rollback or turn-continuation system.
