# Releasing

For a normal release, run **Actions → Prepare next release → Run workflow** and
choose a patch, minor, or custom version. It opens a tiny version-bump PR;
merging that PR automatically starts **Release** and assembles a draft from the
exact merge commit. Review and publish the draft when it is ready.

The existing **Actions → Release → Run workflow** button remains available for
reruns and recovery. It
builds macOS (arm64 + x64, signed, notarized, stapled), Windows, and Ubuntu
from a single pinned commit, verifies every artifact the way a user would
receive it, and assembles the canonical draft in
[Astra releases](https://github.com/milind-soni/Astra/releases).
The exact same assets are also staged in the public legacy releases repo so
installed builds from 0.1.46 and earlier can update across the repository
migration.

Tick **publish** to publish and verify the canonical release first, then make
the identical legacy updater bridge visible. Leave it unticked to review the
canonical draft; when you publish that draft in GitHub's UI, the **Sync
published release** workflow
verifies and publishes its legacy mirror automatically. Never publish only the
legacy draft.

The workflow refuses to overwrite an already-published version. Manual Release
runs still require `package.json`'s version to be bumped on the selected ref.
A release is rejected if any installer, stable download
name, updater feed, blockmap, size, or digest is absent or inconsistent.

GitHub generates the release body from pull requests since the previous
canonical tag. The docs changelog combines published canonical releases with
the legacy archive into one complete history and caches it for five minutes.
Configure the optional Vercel hook below to rebuild the docs immediately after
publication; otherwise the live cache or the next normal docs deployment
refreshes it.

## Updater migration invariant

**Current state, 2026-09-20.** The Astra rename is staged throughout the
codebase but has not been made on GitHub. `milind-soni/Astra` and
`milind-soni/astra-releases` both resolve to nothing, so builds that named
them baked a feed that 404s on every check — the installed app reports
"up to date" forever and nothing is ever delivered. Until the rename lands,
the feed target (`electron-builder.yml`), the browser-engine download
(`server/browser-engine-release.ts`), the in-app links (`src/lib/app-links.ts`)
and the CI assertions that pin all of them name `milind-soni/OpenMausBot`,
which is where the releases and the pinned browser assets actually are.

Renaming the repository to `Astra` is the fix that reaches already-installed
apps — GitHub redirects the old name, so both spellings keep working. Before
the rename, note that the existing releases there carry the *old* brand, and
v0.1.84 is newer than the Astra builds installed today: an installed 0.1.75
would be offered `OpenMausBot-0.1.84-setup.exe`. Cut an Astra-named version
above 0.1.84 on the renamed repository first. `astra-releases` is missing and
must be created before the legacy-mirror half of the Release workflow can run.

The invariant itself:

`app-update.yml` is baked into every packaged desktop app. Builds through
0.1.46 point to `milind-soni/astra-releases`; newer builds point to
`milind-soni/Astra`. For that reason:

1. Every new release is published byte-for-byte to both repositories during
   the bridge period.
2. `astra-releases` must stay public. Do not delete its final bridge
   release, feeds, or assets.
3. README and docs downloads point at the canonical repo, while the legacy
   mirror exists only for installed updater clients and historical releases.

The npm package is published separately and its versioned `.tgz` is attached
only to the canonical release. It is not a desktop updater artifact; the
mirror checks permit that one extra file while still verifying the complete,
byte-identical desktop asset set.

## Why the gates exist

Each verification step in `release.yml` maps to a real incident from the
hand-cut releases (0.1.15–0.1.25): stale build output breaking the code
signature, a bare import killing the packaged server on launch while every
check stayed green, helper paths resolving outside the app after bundling,
stapling silently invalidating every published hash, and a finished release
sitting invisible as a draft. Don't remove a gate without reading the comment
above it.

## Bundled browser gates

Desktop builds also stage a pinned engine and Chromium Headless Shell before
packaging. Pre-signing checks validate complete resources and upstream hashes;
native browser smoke tests and macOS signature checks run on the packaged
output. See [browser packaging](browser-packaging.md) for update ownership,
license provenance and Linux sandbox constraints. Missing browser resources
must fail the build, not ship an installer that downloads them on first use.

## One-time setup: release secrets

Set these in **Astra → Settings → Secrets and variables → Actions**.

The **Prepare next release** workflow also needs
**Settings → Actions → General → Workflow permissions → Allow GitHub Actions
to create and approve pull requests** enabled. The workflow only creates the
version PR; it never approves or merges it.

### 1. `MAC_CERT_P12_BASE64` + `MAC_CERT_PASSWORD`

The Developer ID Application certificate, exported from the Mac that
currently signs releases:

```sh
# Keychain Access → My Certificates → "Developer ID Application: Milind Soni
# (993D98NH4J)" → right-click → Export… → .p12 with a strong password, then:
base64 -i DeveloperID.p12 | pbcopy   # → MAC_CERT_P12_BASE64
# the export password             → MAC_CERT_PASSWORD
```

### 2. `APPLE_API_KEY_P8_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID`

An App Store Connect API key for notarization (better than an app-specific
password for CI — revocable, scoped, no 2FA dance):

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Generate a **Team Key** with the **Developer** role
3. Download the `.p8` (one chance only), note the Key ID and Issuer ID

```sh
base64 -i AuthKey_XXXXXXXX.p8 | pbcopy   # → APPLE_API_KEY_P8_BASE64
```

### 3. `RELEASES_PAT`

A fine-grained personal access token that lets the workflow write to the
legacy updater mirror: **GitHub → Settings → Developer settings →
Fine-grained tokens** → repository access: only `astra-releases` →
permissions: **Contents: Read and write**. Set a long expiry and a calendar
reminder. The canonical release uses the workflow's scoped `GITHUB_TOKEN` and
does not need a PAT.

### 4. Optional `DOCS_DEPLOY_HOOK_URL`

In Vercel, open the docs project and create a **Deploy Hook** for its production
branch. Store that private URL as the `DOCS_DEPLOY_HOOK_URL` repository secret.
Publishing a release then requests a fresh docs deployment so the generated
changelog appears immediately. Do not put the hook URL in source control.

### Local fallback

The hand-cut path still works when Actions is down or a release needs
surgery: `pnpm package:mac`, gate with `codesign --verify --deep --strict`,
notarize with the local keychain profile (`xcrun notarytool submit …
--keychain-profile AC_PASSWORD`), staple, re-zip, regenerate blockmaps and
`node scripts/regenerate-mac-feed.mjs`, upload the identical complete asset set
to both repositories, publish and verify the canonical release before the
legacy mirror, and always verify the published bytes against the published feed
by downloading them back.
