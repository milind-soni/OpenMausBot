# Releasing

One workflow builds everything: **Actions → Release → Run workflow**. It
builds macOS (arm64 + x64, signed, notarized, stapled), Windows, and Ubuntu
from a single pinned commit, verifies every artifact the way a user would
receive it, and assembles the canonical draft in
[OpenMausBot releases](https://github.com/milind-soni/OpenMausBot/releases).
The exact same assets are also staged in the public legacy releases repo so
installed builds from 0.1.46 and earlier can update across the repository
migration.

Tick **publish** to publish and verify the canonical release first, then make
the identical legacy updater bridge visible. Leave it unticked to review the
canonical draft; when you publish that draft in GitHub's UI, the **Sync
published release** workflow
verifies and publishes its legacy mirror automatically. Never publish only the
legacy draft.

The workflow refuses to overwrite an already-published version, so the only
prerequisite per release is that `package.json`'s version is bumped on the
ref you run it against. A release is rejected if any installer, stable download
name, updater feed, blockmap, size, or digest is absent or inconsistent.

GitHub generates the release body from pull requests since the previous
canonical tag. The docs changelog combines published canonical releases with
the legacy archive into one complete history and caches it for five minutes.
Configure the optional Vercel hook below to rebuild the docs immediately after
publication; otherwise the live cache or the next normal docs deployment
refreshes it.

## Updater migration invariant

`app-update.yml` is baked into every packaged desktop app. Builds through
0.1.46 point to `milind-soni/openmausbot-releases`; newer builds point to
`milind-soni/OpenMausBot`. For that reason:

1. Every new release is published byte-for-byte to both repositories during
   the bridge period.
2. `openmausbot-releases` must stay public. Do not delete its final bridge
   release, feeds, or assets.
3. README and docs downloads point at the canonical repo, while the legacy
   mirror exists only for installed updater clients and historical releases.

## Why the gates exist

Each verification step in `release.yml` maps to a real incident from the
hand-cut releases (0.1.15–0.1.25): stale build output breaking the code
signature, a bare import killing the packaged server on launch while every
check stayed green, helper paths resolving outside the app after bundling,
stapling silently invalidating every published hash, and a finished release
sitting invisible as a draft. Don't remove a gate without reading the comment
above it.

## One-time setup: release secrets

Set these in **OpenMausBot → Settings → Secrets and variables → Actions**.

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
Fine-grained tokens** → repository access: only `openmausbot-releases` →
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
