# Science catalog — cross-repo contracts

These are the wire contracts between the three PRs that implement
`docs/superpowers/specs/2026-10-19-science-catalog-design.md`. All three plans
use them verbatim. A change here changes all three plans.

- PR A — openmaus-cloud `feat/science-catalog` (Admin): catalog, relay, caps,
  tokens, upgrade.
- PR B — openmaus-cloud `feat/science-servers`: the five hosted MCP servers
  under `science/`, deployed as one Fly app.
- PR C — OpenMausBot `feat/science-catalog` (desktop).

## 1. Catalog payload (Admin → desktop and Cloud homes)

```ts
type ScienceTag = "no-account" | "free-account" | "paid-account" | "subscription";
type CatalogAuth = "cloud" | "oauth" | "tenant";

interface CatalogEntry {
  id: string;            // stable, e.g. "pubmed", "biorender", "cortellis-regulatory"
  name: string;          // "PubMed"
  group: string;         // a CatalogGroup.id
  tag: ScienceTag;
  description: string;   // one line, as in the spec table
  domain: string;        // favicon domain, e.g. "pubmed.ncbi.nlm.nih.gov"
  auth: CatalogAuth;
  docsUrl?: string;
  url?: string;          // only when the section is unlocked; absent for "tenant"
  urlTemplate?: string;  // tenant only, unlocked only: "https://{tenant}.mcp.benchling.com/mcp"
}

interface CatalogGroup { id: string; title: string }

interface CatalogSection {
  id: "science";
  title: "Science";
  locked: boolean;       // true unless the account/machine tier has the science allowance
  groups: CatalogGroup[];
  entries: CatalogEntry[];
}

interface CatalogResponse { version: 1; sections: CatalogSection[] }
```

Groups, in order: `papers` "Papers and preprints", `targets` "Targets and
chemistry", `clinical` "Clinical and regulatory", `lab` "Lab, data and
figures". A group with no entries is omitted.

Launch entries (served): `pubmed`, `biorxiv`, `chembl`, `opentargets`,
`clinicaltrials` (auth `cloud`), and `consensus`, `wiley`, `inductive`,
`synapse`, `biorender` (auth `oauth`). The other nine vendor rows of the spec
table stay in the Admin data file with `enabled: false` until each passes the
inclusion rule; disabled rows are never served.

For `cloud` entries, `url` is `${scienceRelayBase}/${id}/mcp`, where
`scienceRelayBase` is `https://cloud.openmausbot.com/api/cloud/services/science`
in production (derived from the Admin's public origin).

## 2. Admin routes

All JSON. Desktop routes (`/api/cloud/desktop/*`) answer errors in the house shape `{ "error": <code>, "errorDescription"?: string }` and use `invalid_token` for 401. Relay routes (`{scienceRelayBase}/*`) answer `{ "error": <code> }` and use `unauthorized` for 401.

| Route | Auth | Result |
|---|---|---|
| `GET /api/cloud/desktop/catalog` | `Bearer omc_…` (desktop account token) | 200 `CatalogResponse` for any signed-in account (locked unless the account tier allows science). 401 `invalid_token`. |
| `POST /api/cloud/desktop/services/science` | `Bearer omc_…` | 200 `{ "url": scienceRelayBase, "token": "omb_sd_…", "expiresAt": <epoch ms> }` when allowed. 402 `subscription_inactive` otherwise. Same per-device issue limit as `services/x`. |
| `GET {scienceRelayBase}/catalog` | `Bearer omb_sd_…` or the Cloud home's science token | 200 `CatalogResponse` (locked by the tier at request time). |
| `POST\|GET\|DELETE {scienceRelayBase}/{db}/mcp` | `Bearer omb_sd_…` or the Cloud home's science token | Streamable HTTP MCP, forwarded to PR B. 401 `unauthorized`; 402 `subscription_inactive` (no science allowance); 404 `unknown_server`; 429 `quota_exceeded`; 502 `upstream_unavailable`. |
| `POST /api/cloud/desktop/upgrade` | `Bearer omc_…`, body `{ "plan": "max", "source": "science" }` | 200 `{ "status": "upgraded", "tier": "max", "trial": boolean }`; 202 `{ "status": "pending" }` (Dodo is still taking the payment; poll the session); 402 `payment_failed` (plan unchanged); 409 `not_subscribed` (use checkout); 409 `already_on_plan`; 409 `plan_change_unavailable` (renewal off, payment on hold, or trial past its end). |

`{db}` ∈ `pubmed | biorxiv | chembl | opentargets | clinicaltrials`.

Route details:

- Every new desktop route's JSON (`catalog`, `services/science`, `upgrade`,
  success and error) carries `cloudContractVersion`, like the other
  `/api/cloud/desktop/*` routes.
- Science relay token: `omb_sd_` + 43 base64url characters (the X token's
  shape), stored hashed. Lifetime equals the X relay token's. Issuing a new
  token for a device never revokes that device's unexpired tokens, so a
  renewal cannot break a running turn.
- `"science"` is added to the Admin's known checkout/upgrade `source` values
  (funnel tracking).

Cloud homes: the Admin sets `OMB_CLOUD_SCIENCE_URL` (= `scienceRelayBase`,
machine environment) and the secret `OMB_CLOUD_SCIENCE_TOKEN` on every paid
home, the same way it sets `OMB_CLOUD_X_URL` / `OMB_CLOUD_X_TOKEN`. The tier is checked
per request, so a home that is not on Max gets a locked catalog and 402 from
the relay.

## 3. Allowance and cap

- Tier allowance `science: boolean`: `max` true; `starter`, `personal`, `pro`
  false. Overridable through `OMB_CLOUD_TIERS`.
- Monthly cap `scienceCalls`: `max` 20,000; others 0. A Max trial gets the
  pro-rated share, as X research does.
- Only JSON-RPC requests whose `method` is `tools/call` count against the
  cap. `initialize`, `tools/list`, notifications and GET/DELETE do not.

## 4. Relay → hosted servers (Admin → PR B)

- Upstream base from the Admin env `OMB_SCIENCE_UPSTREAM` (e.g.
  `https://mausbot-science.fly.dev`); the relay forwards to
  `${OMB_SCIENCE_UPSTREAM}/${db}/mcp`, same method, body and MCP headers
  (`content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`,
  `last-event-id`).
- The relay removes `authorization` and adds
  `x-mausbot-science-key: ${OMB_SCIENCE_UPSTREAM_KEY}`. PR B rejects any
  request without the right key with 401 before MCP handling.
- PR B serves `GET /healthz` → 200 `ok` without the key.
- PR B servers are stateless, read-only, Streamable HTTP; responses may be
  JSON or SSE and the relay streams them through unbuffered.
- PR B answers GET and DELETE on `/{db}/mcp` with 405 (stateless mode); the
  relay passes that through unchanged.
- An upstream 401 means the relay's key is wrong, not the caller's token: the
  relay answers 502 `upstream_unavailable` (and logs it), never 401.
- Relay upstream timeout is at least 60 s; a single tool call can take ~55 s.
- `mausbot-science` runs exactly one machine (NCBI's rate limit is per API
  key).

## 5. Desktop-side names (PR C, for reference)

- Stored MCP server entries created from the catalog carry
  `catalog: { id: string; auth: "cloud" | "oauth" | "tenant" }`.
- A `cloud` entry is never stored with an `authorization` header; the relay
  token is injected at run time.
