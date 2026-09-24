# OpenMausBot Enterprise

Source-available features for hosted and white-labelled deployments. This
folder has its own [LICENSE](./LICENSE); everything outside it is Apache 2.0.

**Delete this folder and you have the open-source edition.** Core only
reaches the layer through one hook point, `server/enterprise.ts`, which
loads `enterprise/server/index.ts` (or the bundled `index.js`) if it exists
and otherwise reports the open-source edition. No core file imports anything
from here.

Where core looks, in order: `OMB_ENTERPRISE_DIR` when it is set (and then
only there); otherwise beside the server root (a checkout's `enterprise/`,
the npm package's `<package>/enterprise/`), then inside it
(`dist-server/enterprise/`, which is all the Docker image and the packaged
desktop carry; `scripts/bundle-server.mjs` writes the bundled layer and this
LICENSE there).

## How a deployment turns enterprise

Set `OMB_LICENSE_KEY` on the server. The key is `omb1.<claims>.<signature>`:
the claims are visible JSON (who it is for, which entitlements, when it
expires), signed with an Ed25519 key whose public half is baked into
`enterprise/server/license.ts`. Verification is offline, and one build serves
every customer, because the key decides the feature set rather than the code.

`GET /api/edition` reports the outcome:

```json
{ "edition": "enterprise", "customer": "Acme", "features": ["budgets", "whitelabel"], "expiresAt": "2027-09-02", "expiresInDays": 12 }
{ "edition": "enterprise", "customer": "Acme", "features": ["budgets", "whitelabel"], "expiresAt": "2027-09-02", "expiresInDays": -2, "graceEndsAt": "2027-09-09", "notice": "OMB_LICENSE_KEY expired on 2027-09-02; enterprise features keep working until 2027-09-09 while it is renewed" }
{ "edition": "oss", "features": [], "notice": "enterprise layer disabled: OMB_LICENSE_KEY expired on 2027-09-02; renew it to keep enterprise features" }
```

`expiresInDays` is present whenever the key has an expiry; a non-admin
session's `/api/edition` leaves out `expiresInDays`, `graceEndsAt` and the
notice. From 30 days
before it, the server logs a warning at startup and admins see a banner in
Settings. After the expiry date the features keep working for a 7-day grace
period, with the notice above and a banner saying until when; then they stop,
without a restart. The key format and its signature check do not change: the
layer simply accepts a key that expired less than the grace period ago.

A missing, altered, or expired key does not stop an ordinary standalone
server: it runs the open-source edition and the notice says what to fix.
A workspace explicitly configured for hosted sign-in fails closed for remote
access when its `admin` entitlement or identity service is unavailable. It
must not silently fall back to standalone email or pairing credentials.

## Entitlement ids

| id | grants | status |
|---|---|---|
| `whitelabel` | product name, tagline, accent colour, logo, favicon and support link from `brand.json` (below) | shipped |
| `sso` | sign-in through a company identity provider | planned: nothing checks it yet |
| `admin` | Settings → Workspaces and the optional hosted workspace sign-in adapter | shipped |
| `budgets` | one monthly spend limit for the whole workspace, refusing new turns at the cap, with a warning percentage and admin notices (not per bot or per section) | shipped |
| `billing` | sell prices per model: a billable column in Usage → History and its CSV, and per-model prices that replace list prices in cost estimates | shipped |

[FEATURES](./FEATURES) is the authoritative list.

Core gates a feature with `entitled("id")` from `server/enterprise.ts`.
Unknown ids are carried in the key but grant nothing, so keys can be issued
ahead of a feature landing.

## Issuing keys

```sh
node enterprise/scripts/issue-license.mjs keygen          # once; prints the public key to add to license.ts
node enterprise/scripts/issue-license.mjs issue --customer "Acme" --features whitelabel,sso --expires 2027-09-02
```

The signing key lives outside the repo (default
`~/.config/openmausbot-enterprise/signing-key.json`). Rotate by generating a
new pair and appending its public key: keys signed by older pairs keep
working until they expire.

## What goes where

- Could any open-source user want it? It goes in core, as a public PR.
- Org-, admin- or tier-flavoured, or something the next enterprise lead
  would be shown? It lives here, behind an entitlement.
- Customer-specific brand, skills, packages, connectors? The customer's own
  repo: data and config, never a fork.

## Hosted workspace sign-in (`admin`)

The workspace-side adapter in `server/workspace-access.ts` connects to an
independently deployed identity service over HTTPS. The service's console,
invitations, provider gateway and deployment automation are not shipped in
this repository. The desktop and ordinary self-hosted server do not start
or depend on a hosted console.

Operators opt a workspace into this protocol using `OMB_ADMIN_URL`,
`OMB_ADMIN_WORKSPACE` and `OMB_PUBLIC_URL`; a valid `admin` entitlement is
required. The default keeps the local sign-in allow-list as an additional,
narrowing check. Operators may explicitly delegate membership for verified
portal sessions with `OMB_ADMIN_MEMBERSHIP=portal`; this never exempts ordinary
email or pairing sessions. See the [protocol and isolated verification recipe](../docs/verification/hosted-workspaces.md).

## White-label (`whitelabel`)

Put a `brand.json` in the server's data dir (`OMB_DATA_DIR`, the `/data`
volume in Docker) or point `OMB_BRAND_FILE` at one:

```json
{
  "name": "Reliable Platform",
  "tagline": "Back office, on autopilot",
  "accent": "#1D4ED8",
  "logo": "data:image/svg+xml;base64,…",
  "favicon": "data:image/png;base64,…",
  "supportUrl": "https://help.example.com"
}
```

Only `name` is required. `logo` is an inline `data:image/…` URI or an
`https://` URL; `accent` is a 6-digit hex colour, and the text colour on it
is derived for contrast. The server reads the file on every `GET /api/brand`,
so edits show on the next reload; the app fetches it before the first paint,
so the window never flashes the default name. An unlicensed server, or a
file with a mistake, keeps the default brand and says why in `/api/brand`
and the startup log.

What `brand.json` cannot change, because it is baked at packaging time: the
desktop app's bundle and menu-bar name, installer names, the macOS
permission prompts, the iOS app's name, and the helper apps' paths. A fully
rebranded desktop build is a per-customer packaging job, not config.
