# OpenMausBot Enterprise

Source-available features for hosted and white-labelled deployments. This
folder has its own [LICENSE](./LICENSE); everything outside it is Apache 2.0.

**Delete this folder and you have the open-source edition.** Core only
reaches the layer through one hook point, `server/enterprise.ts`, which
loads `enterprise/server/index.ts` if it exists and otherwise reports the
open-source edition. No core file imports anything from here.

## How a deployment turns enterprise

Set `OMB_LICENSE_KEY` on the server. The key is `omb1.<claims>.<signature>`:
the claims are visible JSON (who it is for, which entitlements, when it
expires), signed with an Ed25519 key whose public half is baked into
`server/license.ts`. Verification is offline, and one build serves every
customer, because the key decides the feature set rather than the code.

`GET /api/edition` reports the outcome:

```json
{ "edition": "enterprise", "customer": "Acme", "features": ["sso", "whitelabel"], "expiresAt": "2027-09-02" }
{ "edition": "oss", "features": [], "notice": "OMB_LICENSE_KEY expired on 2027-09-02; renew it to keep enterprise features" }
```

A missing, altered, or expired key never stops the server: it runs the
open-source edition and the notice says what to fix.

## Entitlement ids

| id | grants |
|---|---|
| `whitelabel` | product name, logo and colours from `brand.json` (next PR) |
| `sso` | identity-header trust behind an OIDC proxy |
| `admin` | the admin panel routes |
| `budgets` | per-bot and per-section spend limits |

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
