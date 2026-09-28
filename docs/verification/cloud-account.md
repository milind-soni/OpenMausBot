# Optional personal OMB Cloud account

Personal Cloud is independent of Settings → Organization, the hosted Companion
account, local profile fields, providers, bots and chat history. Fresh startup
without a saved Cloud credential makes no Cloud request and opens no browser.
Cloud authentication is optional; its failure never blocks free local use.

## Contract and boundaries

The installed desktop uses only `https://cloud.openmausbot.com`. The renderer
cannot supply an origin, callback URL, account credential, checkout URL or Pro
flag. Explicitly injected HTTP loopback is available only to isolated fixtures.
These endpoints belong to the remote Cloud service, not the local app server.

- `POST https://cloud.openmausbot.com/api/cloud/desktop/authorize` accepts
  `deviceName`, `platform` and optional `appVersion`. It returns `cloudContractVersion: 1`, a private
  `deviceCode`, a display `userCode`, `expiresIn` (at most 600 seconds),
  `interval` (5–60 seconds), and the exact same-origin browser destination
  `/cloud/desktop?code=<userCode>`.
- The browser completes email-code authentication and explicit device approval.
  Electron polls `POST https://cloud.openmausbot.com/api/cloud/desktop/token`
  with the private device code.
  A successful response has `cloudContractVersion: 1`, `accessToken` (`omc_`
  plus 43 base64url characters), `expiresAt`, `device: {id}` and
  `account: {id,email}`. Pending/slow-down/denied/expired replies follow the
  existing device-authorization error convention.
- Electron persists only the credential and identity in a separate OS-encrypted
  `cloud-account.bin`. It never persists Pro, writes the local workspace config,
  or sends this token to renderer JavaScript, organization services or engines.
- `GET https://cloud.openmausbot.com/api/cloud/desktop/session` with the bearer
  returns the same identity,
  contract version and expiry, plus
  `entitlement: {plan: "free" | "pro", status: "active" | "inactive",
  expiresAt: number | null, version: number}`. Timestamps are integer Unix
  milliseconds. Identity mismatch/401/403 requires reauthentication; other
  failures remove verified entitlement until a successful retry.
  Active Pro requires a non-null future expiry; a free/active combination or
  already-expired active entitlement is refused as an invalid response.
- Only this verified session can display Pro. Verification lasts at most one
  minute and never past credential or active-entitlement expiry; it is never
  restored from disk. The browser dashboard is the fixed `/cloud` URL. Opening
  it does not activate Pro. Refresh checks the server after a purchase.
- Sign-out independently deletes the local credential and requests
  `DELETE https://cloud.openmausbot.com/api/cloud/desktop/session`. A failed
  remote revocation is disclosed; failure to clear the durable record blocks
  a new sign-in until cleanup works.
  Sign-out does not cancel the subscription or disconnect the organization.

There is no credential-bearing deep link and no checkout-result callback.
Device polling completes browser approval automatically. The existing
`openmausbot://organization` action is unchanged.

## Automated fixtures

```sh
node --test electron/cloud-account.node-test.mjs electron/cloud-account-ipc.node-test.mjs electron/organization-reopen.node-test.mjs
pnpm exec vitest run src/components/CloudAccountSettings.test.ts src/components/SettingsModal.appearance.test.ts src/components/OrganizationSettings.test.ts
pnpm exec tsc --noEmit
pnpm check:electron
pnpm i18n:check
```

Client tests launch their own loopback HTTP server. They cover optional startup,
private polling, strict URLs, stale/cancelled responses, failed persistence,
revocation, network/malformed session failure, expiry, and explicit sign-out.
Storage tests use a temporary file and substitute encryption; they do not touch
the user's keychain. Production preload/main IPC tests reject remote and child
frames and verify renderer arguments cannot cross the account boundary.

## Rendered workflow

```sh
node scripts/verify-cloud-account.mjs
```

The script accepts no external address. It launches an isolated Vite preview,
Electron HOME/profile and synthetic Cloud endpoint. It uses the actual settings
component, production preload and account client. No installed app, user data,
real browser sign-in, provider, payment, keychain or customer account is used.

It checks no sign-in at startup, cancel/retry, automatic connection after fake
approval, free state, checkout not activating Pro, verified activation, network
failure, revocation, confirmed sign-out, 390px overflow and remote-page isolation.
The printed evidence directory retains `receipt.json`, `electron.log` and two
screenshots. Its owned temporary HOME/profile are removed on completion.

This is not production qualification: browser opens are captured, approval and
entitlements are synthetic, and credential storage is in memory. Real OTP,
billing-webhook activation, keychain persistence and a shipped desktop build
need separate qualification. Server-side enforcement of paid service requests
must remain authoritative; the settings display is not an access-control gate.
