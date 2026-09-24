# Enterprise layer loading and license expiry

## Sub-features

- Find the bundled enterprise layer in every shipped layout: a checkout
  (`enterprise/` beside `server/`), the npm package (`<package>/enterprise/`
  beside `dist-server/`), and the Docker image and packaged desktop, which
  carry `dist-server/` alone (`dist-server/enterprise/`). `OMB_ENTERPRISE_DIR`,
  when set, is the only place looked at.
- From 30 days before a key expires: `expiresInDays` on `/api/edition`, a
  warning in the startup log, and a banner in Settings for admins. The dates
  reach admin sessions only: a member's `/api/edition` and config leave out
  `expiresInDays`, `graceEndsAt` and the notice.
- For 7 days after it expires the entitlements keep working, with a notice,
  `graceEndsAt` on `/api/edition`, and a banner saying until when. Then they
  stop, without a restart. The key format and signature check are unchanged.

## Driving it

```sh
pnpm exec vitest run server/enterprise.test.ts enterprise/server/register.test.ts
pnpm exec vitest run --no-file-parallelism server/license-expiry-api.test.ts server/hosted-access.test.ts
pnpm test:packaged-server
```

`server/enterprise.test.ts` builds each layout in a temporary directory and
checks which copy wins, the warning window, the grace period and the moment it
ends. `enterprise/server/register.test.ts` issues keys with a throwaway signing
pair and checks the layer accepts a key that lapsed less than 7 days ago and
refuses it after. `server/license-expiry-api.test.ts` boots the `control-omb`
fixture with a stand-in layer whose key expires in 12 days, expired 2 days
ago, or expires in 90 days, and reads `/api/edition`, the server log, and
`/api/config` as an admin and as a chat-only device.
`server/hosted-access.test.ts` checks a hosted server withdraws readiness the
moment its grace period ends. The packaged-server smoke copies `dist-server/`
out of the repository, boots it with a key that is not genuine, and fails if
`/api/edition` says no layer exists; the Docker workflow makes the same check
against the built image.

## Gotchas

- Tested on 2026-09-23 against disposable fixtures only: stand-in layers,
  throwaway signing keys and a temporary home. No real license key, hosted
  tenant or cloud Admin was involved; this is not production qualification.
- The cloud Admin's own license check (`verifyLicenseKey` called directly) has
  no grace period; only the OMB server's `register()` path does.
- The Settings banner is proven from fixtures in
  `src/components/LicenseExpiryBanner.test.ts`, not driven headlessly.
