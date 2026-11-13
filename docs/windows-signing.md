# Windows code signing

The Windows installer and app are **unsigned** until the signing secrets below
are set. Until then, SmartScreen shows "Unknown publisher" and Smart App
Control blocks the app and its updates outright. Smart App Control has no
per-app exception: a user who has it on must turn it off. Signing with a
certificate from a CA in Microsoft's Trusted Root Program is what Smart App
Control accepts when its cloud service has no verdict on a file. SmartScreen
still warns about new signed downloads until the publisher builds reputation.

With no secrets set, `pnpm package:win` runs `electron-builder --win --publish
never` exactly as before. `scripts/package-win.mjs` decides which build to run.

## What gets signed

Signing runs inside electron-builder, through `scripts/windows-sign.mjs`. Each
binary is signed with a SHA-256 digest, timestamped by the provider's RFC 3161
server, and checked afterwards: it must be Valid, signed by
`WINDOWS_PUBLISHER_NAME`, and carry an RFC 3161 timestamp.

**Signed by us:**

- `OpenMausBot.exe`.
- Electron's unsigned DLLs: `ffmpeg.dll`, `libEGL.dll`, `libGLESv2.dll`, `vk_swiftshader.dll`, `vulkan-1.dll`, `dxcompiler.dll`.
- `cua-driver-background.exe`, a GUI-subsystem copy of the CUA driver whose vendor signature is stripped when it is made.
- `agent-browser.exe`, our Windows build of the browser engine.
- Chrome for Testing's `chrome-headless-shell.exe` and its DLLs.
- `duckdb.node` and `resvgjs.win32-x64-msvc.node`.
- `elevate.exe`, unless it already carries a valid signature.
- The uninstaller.
- `OpenMausBot-<version>-setup.exe`.

**Kept as their vendor signed them** (any binary with a valid signature is left alone):

- `cloudflared.exe` (Cloudflare). It is never re-signed, and the release checks its pinned hash.
- `cua-driver.exe`, `cua_driver_sdk.dll` and `cua_driver_node_runtime.node` (Cua AI).
- `duckdb.dll` (DuckDB Foundation).
- `d3dcompiler_47.dll` and `dxil.dll` (Microsoft).
- Android platform tools (Google).

**Signing happens after the pinned bytes are checked.** The afterPack hook
verifies the pinned bytes of the browser, CUA and DuckDB trees first, then the
`afterSign` hook signs everything under `resources/`. The browser bundle's own
`manifest.json` still lists the vendor hashes of the files we signed. Nothing
reads those hashes after packaging.

Every decision is written to `release/windows-signing-log.jsonl`.

The release's **Gate: every Windows binary is signed and timestamped** step checks:

- Every Portable Executable in `release/win-unpacked` is Valid.
- The installer and `OpenMausBot.exe` are signed by `WINDOWS_PUBLISHER_NAME` with an RFC 3161 timestamp.
- The signing log shows a signed uninstaller.
- `cloudflared.exe` still carries Cloudflare's signature.

## Provider: SSL.com eSigner

The certificate is an SSL.com code signing certificate. An OV certificate is
issued to a company; an IV certificate is issued to a person. The key lives in
SSL.com's cloud HSM, and CI signs through eSigner with SSL.com's CodeSignTool.
The hook downloads CodeSignTool, pinned by SHA-256, and runs it on the Windows
runner's preinstalled Java.

To get the credentials:

1. Buy an OV code signing certificate at ssl.com, or IV for an individual, and choose eSigner cloud signing.
2. Complete validation.
   - For a company:
     - the company's government registry record (for an Indian company, its MCA record);
     - a phone number SSL.com can verify in a third-party directory such as D&B (a D-U-N-S number speeds this up);
     - the requester's photo ID, if the company is under three years old.
   - For an individual: a photo ID and a selfie.
3. Enroll the certificate in eSigner and choose **OTP App**, not SMS. SSL.com shows a QR code; save the secret encoded in it. That secret is `ESIGNER_TOTP_SECRET`.
4. Subscribe to an eSigner tier. One release signs about 20 files, so size the tier as releases per month × 20, plus retries.
5. Find the credential ID in the SSL.com dashboard, or with CodeSignTool's `get_credential_ids`.

## Secrets and variables

Set these under **Settings → Secrets and variables → Actions**.

| Name | Kind | Value |
| --- | --- | --- |
| `ESIGNER_USERNAME` | secret | SSL.com account username |
| `ESIGNER_PASSWORD` | secret | SSL.com account password |
| `ESIGNER_CREDENTIAL_ID` | secret | the eSigner credential ID of the certificate |
| `ESIGNER_TOTP_SECRET` | secret | the OTP App secret from enrollment |
| `WINDOWS_PUBLISHER_NAME` | variable | the subject to require, as a DN, e.g. `CN=Example Private Limited, O=Example Private Limited, C=IN` |
| `WINDOWS_SIGNING_REQUIRED` | variable | unset at first; `true` after the first signed release ships |
| `ESIGNER_ENVIRONMENT` | variable | dry runs only: `sandbox` makes **Package Windows** sign with SSL.com's public test service. Release never reads it. |

**Set all four secrets, or none.** A partial set fails the release.

**`WINDOWS_PUBLISHER_NAME`** must match the certificate's subject:

- Every key you list must equal the certificate's value for it.
- Use the exact legal name as it appears on the certificate.
- Get the subject from SSL.com's order page, or from the dry run's signature table.

**The release checks the settings first.** Its `prepare` job runs
`node scripts/windows-signing.mjs preflight`, so a misconfiguration fails
within a minute. That job sees only whether each secret is set, never its
value.

## Updates: how the switch to signed works

electron-updater checks a downloaded Windows update in a specific way:

- The **installed** app runs the check, after downloading the installer and before running it.
- It runs `Get-AuthenticodeSignature` on the installer. The status must be Valid, and the signer's subject must match a `publisherName` in the installed app's own `resources/app-update.yml`.
- An app with no `publisherName` installs any update.

So a `publisherName` written into a release is a promise for every later
release. An install that has one refuses every unsigned update, and every
update signed by a different subject. Its user has to reinstall by hand.

The rollout uses two releases.

1. **First signed release.** Set the four secrets and `WINDOWS_PUBLISHER_NAME`, and leave `WINDOWS_SIGNING_REQUIRED` unset.
   - Every binary is signed.
   - `app-update.yml` has **no** `publisherName`, so the gate still asserts there is none.
   - Existing unsigned installs update to it normally, because they verify nothing.
   - If anything about the certificate turns out wrong, nobody is stranded.
   - Before the release, run **Actions → Package Windows** on the release branch as a dry run. It signs with the real certificate and runs the same signature gate.
2. **Check the shipped release.** On a Windows PC with Smart App Control on, install `OpenMausBot-setup.exe`. Confirm that it installs and that the app starts. Check that **Properties → Digital Signatures** shows the expected name and a timestamp.
3. **Set `WINDOWS_SIGNING_REQUIRED=true`.** From the next release on:
   - The release fails, in preflight or in the Windows job, if the secrets are missing or any signature check fails. It never publishes an unsigned build.
   - `app-update.yml` carries `publisherName: [WINDOWS_PUBLISHER_NAME]`, and the gate checks that it is exactly that.
   - Installs from this release onward refuse a tampered or unsigned update.
   - Installs from the first signed release do not verify; they move onto verifying builds with this update.

Verification is switched on one release after signing for two reasons. The
switch that writes `publisherName` is the same switch that makes every later
release fail rather than ship unsigned. And the subject that installs will
enforce forever is checked on a real shipped build first.

## Dry run without a real certificate

SSL.com runs a public sandbox with demo credentials. To try the whole signed
path on a fork, with no purchase:

1. Fork the repository.
2. Add the four `ESIGNER_*` secrets with SSL.com's demo account. The values are on SSL.com's "eSigner Demo Credentials and Certificates" page.
3. Set the variable `ESIGNER_ENVIRONMENT=sandbox`.
4. Set `WINDOWS_PUBLISHER_NAME` to the demo certificate's subject. If you don't know it, the first run's error prints it.
5. Run **Actions → Package Windows** on the fork.

The demo certificate does not chain to a root Windows trusts. In sandbox mode
the hook and the gate accept "untrusted root" for our own signatures. Every
other check still applies: signer, RFC 3161 timestamp, every binary covered,
and vendor signatures kept. `sandbox` can never be combined with
`WINDOWS_SIGNING_REQUIRED`.

## Rolling back

**Before `WINDOWS_SIGNING_REQUIRED` is set:**

- Delete the secrets, and the next release is unsigned exactly as before.
- Installs from the signed release still accept it, since they verify nothing.

**After it is set:**

- Never publish an unsigned Windows build. The workflow refuses one.
- If signing breaks (an expired subscription, say), fix the credentials and re-run the release. Do not unset the variable to get a release out.
- If you unset `WINDOWS_SIGNING_REQUIRED` and delete the secrets, installs that verify the publisher will refuse every later update. Their users must reinstall by hand.

**Changing the certificate subject** (a new company name, a new CA) needs one
transition release. Its `publisherName` lists both subjects, while the release
is still signed with the old certificate. Only then switch certificates. This
needs a code change to pass both names. Keep the subject stable otherwise.

**Renewing the same certificate** (same subject) needs nothing. Signatures are
timestamped, so older releases stay valid after the certificate expires.

## Switching provider

Microsoft's Artifact Signing (formerly Trusted Signing) is cheaper, but
Microsoft's documentation limits it to organizations in the USA, Canada, the
EU, the UK and a few other countries, and to individuals in the USA and
Canada. India is not on the list.

To move to Artifact Signing, or to an OV certificate in Azure Key Vault:

1. Add a provider to `PROVIDERS` in `scripts/windows-signing.mjs`, with its secret names.
2. Add a signer to `SIGNERS` in `scripts/windows-sign.mjs`. It signs one file in place with a SHA-256 digest and an RFC 3161 timestamp. For Artifact Signing that is the `TrustedSigning` PowerShell module's `Invoke-TrustedSigning` (what electron-builder's `azureSignOptions` runs), or signtool with the Artifact Signing dlib. For Key Vault it is AzureSignTool.
3. Pass the new secrets in the release workflow.

Everything else stays the same: the per-file decisions, the gates and the update rules.
