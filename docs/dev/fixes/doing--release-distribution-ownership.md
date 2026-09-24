---
status: doing
created: 2026-09-24
updated: 2026-09-24
scope: release distribution ownership
owner: assistant
related: [doing--harness-server-security.md, doing--reliability-and-polish.md]
---

# Point release, update, and telemetry plumbing at this fork before shipping an installer

Pre-release audit (2026-09-24). Several distribution endpoints still belong to the upstream OpenMausBot author. Shipping an installer as-is would send our users' data and update checks to someone else's accounts. This covers the auto-update feed, analytics, code signing, and repository hygiene before the first push and release. It does not cover app features.

---

## 1. Third-party ownership (release blockers)

- [~] **Repoint the auto-update feed** — `electron-builder.yml:11`. `publish.owner` is `milind-soni` (`gerer-build-studio-releases`). Installed apps would poll, and could install, builds from the upstream author's repository. Create a public releases repository under `myebstudios`, or publish to `myebstudios/GererBuildStudio` releases, and update `owner` and `repo`.
- [~] **Replace the PostHog project token** — `src/lib/analytics.ts:8`. This token was added by upstream commit `4a856c6`. Autocapture events and the emails collected by the first-run gate (`identify()` at `src/lib/analytics.ts:40`) currently go to the upstream author's PostHog project. Use our own token from env or build config, or disable analytics until we have one.
- [~] **Add an analytics opt-out and a privacy note** — `src/lib/analytics.ts:12`. Autocapture records clicks and inputs in an app where users type prompts and keys. At minimum, disable input autocapture (`mask_all_text`/`autocapture: { dom_event_allowlist: ["click"] }`), add a Settings toggle, and mention it in `README.md`.

## 2. Code signing and notarization

- [~] **Obtain a Developer ID Application certificate** — `electron-builder.yml:47`. The only local identity is `Apple Development: myebstudios@gmail.com`, which cannot produce a DMG that runs on other Macs without Gatekeeper blocking it. Mac auto-update (Squirrel.Mac) also requires Developer ID signing. Until we have one, label builds as internal, unsigned-for-distribution.
- [~] **Automate notarization** — `electron-builder.yml:58`. `notarize: false` depends on a manual `notarytool` step that is not written down in this repository. Enable electron-builder notarization with `APPLE_API_KEY`/`APPLE_API_ISSUER` env, or add `scripts/release-mac.sh`.
- [~] **Decide on Windows signing** — `electron-builder.yml:70`. Unsigned NSIS installers trigger SmartScreen warnings. Either accept that and document it, or configure a certificate.
- [~] **Trim hardened-runtime entitlements** — `build/entitlements.mac.plist:9`. `allow-dyld-environment-variables` and `disable-library-validation` weaken the runtime. Keep them only if the CUA driver or speech helper actually needs them, and document why.

## 3. Repository and release hygiene

- [~] **Resolve uncommitted work before pushing** — `server/composio.ts`, `server/index.ts`, `server/composio.test.ts`, `dist-server/*`, and two `done--` docs are modified or untracked. Commit them as a scoped change or stash them. Decide whether `Ai workflow template/` (untracked, contains `.DS_Store`) belongs in the repository.
- [~] **Tag releases** — The repository has no git tags, yet version is `0.1.14` (`package.json:4`). Tag `v0.1.15` (or whichever version we ship) so update feeds and changelogs map to source.
- [~] **Remove upstream branding from user-facing strings** — `electron/main.mjs:106`. The server-failure page shows a 🐭 and says "restart your Mac" on every platform. Rewrite it to be platform-neutral and include the log path.
- [~] **Update LICENSE attribution** — `LICENSE:3`. MIT requires keeping the upstream notice, which is fine. Add our own copyright line for the fork.
- [~] **Clean stale artifacts before packaging** — `release/` holds 289 MB of 0.1.14 output. Clear it so a failed build can't upload old binaries alongside new `latest-mac.yml`.
