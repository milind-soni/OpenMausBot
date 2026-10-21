# Science catalog (Max) — design

Date: 2026-10-19 · Status: draft for review · Scope: desktop app (macOS,
Windows), MausBot Cloud Admin (milind-soni/openmaus-cloud), a new set of
hosted science MCP servers. Phones: none.

## Why

Anthropic ships "Claude for Life Sciences" connectors (PubMed, ChEMBL,
ClinicalTrials.gov, BioRender, Benchling, Elicit, Cortellis…). Every one of
them is a remote MCP server or a local MCP bundle, and MausBot already speaks
MCP: URL servers, OAuth sign-in with dynamic client registration (DCR, #2066),
pre-registered sign-in apps (#2098), sign-in on a Cloud home through its own
https callback, and tool search for large catalogs (#2470). What is missing is
packaging: today a person has to know each server's address and paste it under
Apps → MCP servers.

Omkar wants these connectors in MausBot so researchers can use them from the
desktop app and from MausBot Cloud, where they can run several research bots
at once. They are a feature of the **Max plan ($99/month)**, not of Free,
Personal or Pro.

People we build for, all of them: a specific lab or customer we are talking
to, biotech and pharma teams (targets, compounds, trials, regulatory work),
academic researchers (literature, datasets, figures), and the MausBot Cloud
launch story. The lab in view would give each researcher their own Max
account; company-managed setups are not in scope.

The connectors are model-agnostic: an MCP server sees MausBot, not the model,
and MausBot hands every enabled MCP server to whichever engine a bot runs on.
So unlike in Claude, a Max user gets these sources with GPT, Gemini, Qwen or
any other engine. That is part of the pitch.

This is piece 1 of 4 proposed on 2026-10-19. The others are separate projects
and out of scope here: (2) more science servers we host, (3) science skills
that keep their scripts plus compute to run them, (4) a "research team"
template for Cloud. This project hosts the five public databases itself (part
of piece 2) because the Max gate depends on it.

## Goals

1. **A connector catalog, served by MausBot Cloud.** Catalog entries are data
   the Cloud sends to the app, rendered as tiles in the existing Apps dialog.
   The machinery is general; v1 ships one section, **Science**.
2. **The Science filter** in the Apps dialog: 19 sources in four groups, each
   with a tag saying what the vendor requires, one-click connect, and a
   "Connect the 5 public databases" button.
3. **Max-only, enforced by MausBot Cloud.** The Cloud sends connectable
   Science entries only to Max accounts, and the five public databases are
   reachable only through a Cloud relay that checks the plan.
4. **A greyed-out teaser for everyone else** with a "Get Max · $99/month"
   button.
5. **Desktop and Cloud home alike**: a desktop signed into a Max account and a
   Cloud home on a Max subscription both get it.

## Non-goals (v1)

- Other catalog sections (the Sept 30 seed list: Higgsfield, Notion, Linear,
  Figma…) and MCP Registry search. The machinery must allow them later.
- Science skills, Python environments, compute, the research-team template.
- Phones. Phone apps have no MCP screen.
- Sources that need a deal or new auth code: Owkin and Boltz (no DCR; need
  client credentials issued to us), EDEN (needs CIMD sign-in), Synthesize Bio
  (its DCR endpoint returned 403), Helix GenoSphere (partner-only), IHME GBD
  (its server refuses non-Claude clients, documented). Amass (purpose not
  verified). Claude Science's built-in sources (UniProt, PDB, AlphaFold,
  Ensembl…) beyond the five public databases.
- Usage-based billing for Science.
- Company-managed deployments (enterprise, self-hosted). Science reaches
  people signed into a Max account only.

## Anti-goals (a failure even if it works)

- **A gate that lives only in the desktop app.** The app is Apache 2.0; a
  local check is removable. Every Max check is made by the Cloud.
- **Gating basics.** Pasting any MCP server address by hand under Apps → MCP
  servers stays free on every plan, including the same vendor URLs.
- **Reselling Anthropic's free servers.** `*.mcp.claude.com` /
  `hcls.mcp.claude.com` are never an upstream, not even temporarily. The
  `mcp.deepsense.ai` URLs in anthropics/life-sciences are dead; don't copy
  that repo's configs.
- **Deleting or silently breaking a person's connections** when their plan
  changes (see "Losing Max").
- Calling the feature "Claude connectors" or using Anthropic branding.

## The screen (approved 2026-10-19)

Screenshots of the approved mock, built from captures of the real Apps dialog
at origin/main 1da83432c:

- `2026-10-19-science-catalog/science-max.png` — Science filter, Max account
- `2026-10-19-science-catalog/science-connected-bottom.png` — connected,
  signing-in and Benchling-address states
- `2026-10-19-science-catalog/science-nomax.png` — teaser without Max
- `2026-10-19-science-catalog/science-all-nomax.png` — All view without Max

Everything below reuses existing Apps dialog markup and strings
(`PluginsPanel.tsx` `renderTile`, the Whop tile's "Bot access" disclosure, the
HighLevel tile's inline form).

**Filter row.** All · **Science** · Productivity · Developer tools ·
Communication · Sales and CRM · More. "Files" moves to the top of the More
menu to make room; with "Science" the row fits on one line at the dialog's
780px width ("Life sciences" did not).

**Science view, Max account.**

- Intro strip (same style as the Composio setup notice): "Research sources
  your bots can search. 5 public databases run on MausBot Cloud and need no
  account; the rest use your own login." Right side: **Connect the 5 public
  databases** (becomes "Public databases connected", disabled, when done).
- Four sections, two-column tile grid, in this order: Papers and preprints ·
  Targets and chemistry · Clinical and regulatory · Lab, data and figures.
- Tile = logo, name, tag pill right after the name, one-line description,
  action button. Tags describe what the *vendor* requires: **No account**
  (green) · **Free account** · **Paid account** · **Subscription**. Never the
  word "Free" alone (it would read wrong next to a $99 feature).
- States, using existing strings where they exist:
  - idle: **Connect**
  - working: spinner in the button
  - signing in: description becomes "Finish setup in your browser", button
    **Continue**, link "Open authorization page" under the tile
  - Benchling: Connect opens an inline form like HighLevel's: one field "Your
    Benchling address, like acme.benchling.com", help text "Benchling gives
    each company its own address. An admin must turn on Benchling AI for your
    tenant first.", and Connect
  - connected: green check after the name, button **Turn off**, a collapsed
    **Bot access** disclosure identical to Whop's (copy names the source,
    "Manage <bot>'s access" buttons)
- The header's **Connected** button counts science connections and shows their
  icons like any other connection ("5 connected").
- The search box filters science tiles by name and description; typing
  switches to the Science filter; empty result: "No science sources match."
- Logos: the app's existing `ServiceIcon` path (an entry's `domain` →
  favicon). The mock used: pubmed.ncbi.nlm.nih.gov, biorxiv.org,
  consensus.app, elicit.com, scite.ai, wiley.com, chembl.gitbook.io,
  platform.opentargets.org, inductive.bio, mavenbio.com, clinicaltrials.gov,
  clarivate.com (both Cortellis entries), adisinsight.springer.com,
  medidata.com, benchling.com, synapse.org, latch.bio, biorender.com.

**All view.** A **Science** section comes first (before Productivity) with
four tiles — PubMed, ChEMBL, Clinical Trials, BioRender — and **View all**,
which switches to the Science filter. Science tiles are connectable even when
Composio is not set up.

**Without Max** (Free, Personal, Pro, signed out). Same filter, same list,
every Connect disabled (the existing greyed style). Intro strip: "Science
sources come with Max. Connect research databases in one click, and run
analysis on the biggest cloud machine." with **Get Max · $99/month**. The
All view's Science section shows the same four tiles greyed.

## The entries

| Group | Name | Tag | Description | Server | Auth |
|---|---|---|---|---|---|
| Papers and preprints | PubMed | No account | Biomedical papers and abstracts from NCBI | ours (relay) | cloud |
| | bioRxiv and medRxiv | No account | Preprints in biology and medicine | ours (relay) | cloud |
| | Consensus | Free account | Answers drawn from peer-reviewed studies | `https://mcp.consensus.app/mcp` | oauth (DCR) |
| | Elicit | Paid account | Systematic reviews and data extraction | `https://elicit.com/api/mcp` | oauth (DCR) |
| | Scite | Paid account | See whether papers support or dispute a claim | `https://api.scite.ai/mcp` | oauth (DCR) |
| | Wiley Scholar Gateway | Free account | Full text from Wiley journals | `https://connector.scholargateway.ai/v2/mcp` | oauth (DCR) |
| Targets and chemistry | ChEMBL | No account | Bioactive molecules, targets and assays | ours (relay) | cloud |
| | Open Targets | No account | Evidence linking targets to diseases | ours (relay) | cloud |
| | Inductive Bio | Free account | ADMET predictions for your molecules | `https://api.inductive.bio/mcp` | oauth (DCR) |
| | Maven Bio | Paid account | Biopharma pipeline and deal intelligence | `https://mcp.mavenbio.com` | oauth (DCR) |
| Clinical and regulatory | Clinical Trials | No account | Studies from ClinicalTrials.gov | ours (relay) | cloud |
| | Cortellis Regulatory | Subscription | Regulatory guidance across markets | `https://api.clarivate.com/lifesciences/mcp-regulatory/mcp` | oauth (DCR) |
| | Cortellis CMC | Subscription | Manufacturing and quality intelligence | `https://api.clarivate.com/lifesciences/mcp-cmc/mcp` | oauth (DCR) |
| | AdisInsight | Subscription | Drug pipelines, trials and deals | `https://adisinsight-mcp.springer.com/mcp` | oauth (DCR) |
| | Medidata | Subscription | Your studies in Medidata | `https://mcp.imedidata.com/mcp` | oauth (DCR) |
| Lab, data and figures | Benchling | Subscription | Your notebook, registry and results | `https://<tenant>.mcp.benchling.com/mcp` | tenant + oauth |
| | Synapse | Free account | Shared research datasets from Sage | `https://mcp.synapse.org/mcp` | oauth (DCR) |
| | LatchBio | Paid account | Run bioinformatics workflows on Latch | `https://mcp.latch.bio/mcp` | oauth (DCR) |
| | BioRender | Free account | Scientific figures and icons | `https://mcp.services.biorender.com/mcp` | oauth (DCR) |

Facts behind the table (live probes on 2026-10-19; DCR registration succeeded
and the authorize step reached the vendor's login for every "oauth (DCR)" row;
no sign-in was completed):

- Vendors that document other clients: BioRender, Synapse, Elicit, Scite,
  LatchBio, Maven Bio, Wiley, AdisInsight, Cortellis (Claude, M365 Copilot and
  an API key path). Consensus and Inductive Bio work by DCR but document only
  Claude. Medidata is for Medidata customers.
- Cortellis advertises the scope `claudeai`; confirm it accepts our client.
- Benchling's per-tenant URL pattern came from a search snippet of Benchling's
  help page and is **unverified**.
- **Inclusion rule (from the Sept 30 spec): each vendor entry ships only after
  it signs in end to end from MausBot and lists tools.** An entry that fails
  is left out of the served catalog (the catalog is data, so it can return
  later without an app release).
- **Launch set (Omkar, 2026-10-19): launch with what passes.** That is the five
  hosted databases plus the free-account vendors that pass the inclusion
  rule: Consensus, Wiley Scholar Gateway, Inductive Bio, Synapse, BioRender.
  Elicit, Scite, Maven Bio, LatchBio, Cortellis Regulatory, Cortellis CMC,
  AdisInsight, Medidata and Benchling join the served catalog one by one as
  real accounts become available to test them; no app release is needed. A
  group with no entries is hidden; group order stays as in the table.
- Before Cortellis ships, read Clarivate's terms for whether they limit which
  AI provider may receive Cortellis data (the connector is "subject to
  Clarivate's terms"); MausBot sends tool results to whatever engine the
  person chose.

## How it works

### 1. The catalog is served by MausBot Cloud

- New Admin routes, following `cloud-desktop.ts` / `cloud-services.ts`:
  - desktop: `GET /api/cloud/desktop/catalog`, account token (`omc_…`) held by
    Electron main, as `xResearchAccess()` does
  - Cloud home: `GET {OMB_CLOUD_SCIENCE_URL}/catalog` with the home's science
    token, resolved with `serviceAccess` (see the contracts doc)
- Response: sections, each `{ id, title, locked, entries }`. An entry carries
  `id, name, group, tag, description, domain, auth ("cloud" | "oauth" |
  "tenant"), docsUrl` and, **only when the section is unlocked**, `url` (or
  `urlTemplate` for tenant entries).
- The Max check is a new per-tier allowance, `science: boolean`, in the tier
  defaults in `server/cloud-plans.ts` (`max: true`, all others `false`),
  overridable through `OMB_CLOUD_TIERS` like the other allowances. There is no
  shared "is this account on plan X" helper today; add the allowance rather
  than comparing `tier === "max"` in each route.
- The catalog's content (the table above) lives in the Admin repo as a data
  file with a schema test, so entries can be fixed or dropped without a
  desktop release.
- The desktop keeps a bundled **teaser copy** (names, groups, tags,
  descriptions, domains; no URLs) so the greyed teaser shows when signed out
  or offline. It lists the launch set only, so it never advertises a source
  Max can't connect. Signed in, the served catalog wins, locked or not, and
  can list later additions.
- Desktop transport follows the included-X pattern: Electron main fetches with
  the account token and hands the result to the server process over the
  parent port; the server serves it to the renderer. The token never reaches
  the server process or the renderer.

### 2. Connecting an entry

Reuse the existing URL-server flow (`POST /api/mcp/servers` → sign in → Test →
enable). The new part is the auth kind:

- **oauth**: the existing MCP sign-in (`server/mcp-oauth.ts`). On a Cloud home
  the callback is the home's https origin, as today.
- **tenant** (Benchling): build the URL from the address the person types,
  validate it is `https://<name>.mcp.benchling.com/mcp`, then oauth.
- **cloud** (our five databases): a new kind. The stored server entry is
  marked as a MausBot Cloud server (no secret in `config.json`). At run time
  the credential is injected at the existing seam, `withMcpSignIn`
  (`server/mcp-oauth.ts:603-619`), as `Authorization: Bearer <relay token>`,
  the same way `xCredential()` is held for X research. `authState` gains a
  state for "MausBot Cloud: needs Max" so the UI and turns can tell it apart
  from "needs sign-in".
  - Desktop relay token: new `POST /api/cloud/desktop/services/science`
    (mirrors `services/x`), minted only when the account's tier allows
    science.
  - Cloud home: a Fly secret minted by the Admin (`OMB_CLOUD_SCIENCE_URL` /
    `OMB_CLOUD_SCIENCE_TOKEN`), held like `holdIncludedServices`.
- Created entries are named from the catalog id (suffixed on collision) and
  matched back to their tile by URL, so a server added by hand with the same
  URL shows as connected.
- **"Connect the 5 public databases"** connects the five `cloud` entries one
  after another.
- **Turn off** disables the server; Remove and Sign out stay where they are
  today (Apps → MCP servers).
- **Bot access** uses the existing per-bot MCP selection; nothing new.
- **Server limit.** `MAX_MCP_SERVERS = 20` (`server/mcp-registry.ts:48`)
  counts every stored server, enabled or not; 19 science entries plus a
  person's own servers would hit it. Raise it to 50 (my call). It is enforced
  in `routes/mcp-servers.ts`, `mcp-registry.ts`, `setup-import.ts` and
  `package-import.ts`; change the constant, not each site. The per-bot server
  selection limit rises with it.

### 3. The relay and our hosted servers

- New Admin relay path `/api/cloud/services/science/<db>/mcp`, routed through
  `portal.ts`'s `/api/cloud/services/*` like X research. It authenticates the
  token (`authenticateX`-style: machine or user), checks the `science`
  allowance (402 `subscription_inactive` when missing), reserves a call
  against a monthly cap, and forwards the Streamable HTTP request to the
  internal server for `<db>`.
- Monthly cap on Max: 20,000 science calls (my call; tune after launch),
  enforced like `reserveX` / `xUsedUp` with a 429 `quota_exceeded`.
- A Max free trial unlocks Science with a pro-rated share of the cap, as X
  research does today.
- The five servers, all read-only and stateless, permissive licences only:
  - PubMed and Clinical Trials: an Apache-2.0 or MIT server such as
    cyanheads/pubmed-mcp-server and cyanheads/clinicaltrialsgov-mcp-server
    (Apache-2.0) or genomoncology/biomcp (MIT, covers both).
  - Open Targets: opentargets/platform-mcp (Apache-2.0, official).
  - ChEMBL and bioRxiv/medRxiv: no permissively licensed server was found
    (Augmented-Nature's servers are non-commercial; JackKuo666's bioRxiv
    server has no licence), so we write two small servers over the public
    ChEMBL REST API and the bioRxiv API.
- Upstream etiquette: an NCBI API key plus `tool`/`email` parameters for
  E-utilities; ChEMBL data is CC BY-SA 3.0, so attribute it in results;
  check the bioRxiv API terms; Open Targets data is CC0.
- The servers must not be reachable except through the relay (private network
  or a shared secret the relay adds).

### 4. Losing Max

- Relay entries start answering 402. The app shows those servers as "Needs
  Max" with **Get Max**, and leaves the stored entries alone.
- Vendor entries a person already connected keep working: they sign in to
  their own vendor accounts, and hand-added MCP servers are never gated. The
  Science tiles turn back into the teaser.
- Nothing is deleted.

### 5. Get Max

- Free or signed out: the existing checkout, IPC `cloud-account:checkout` →
  `POST /api/cloud/desktop/checkout { plan: "max", source: "science" }`.
- **Personal and Pro subscribers upgrade themselves (Omkar, 2026-10-19).**
  Today checkout answers 409 `already_subscribed` for any active subscriber
  (`cloud-desktop.ts:291`), and the Admin's only plan change is a trial moving
  down to Personal (Dodo `changePlan` with `do_not_bill`). This project adds
  a plan change to Max on the Admin, used by Get Max for existing
  subscribers:
  - the prorated difference is charged immediately and Max (and Science)
    unlocks as soon as the payment succeeds
  - if the payment fails, the person stays on their current plan and sees why
  - a person on a trial moves to a Max trial
  - the machine resize on a plan change already exists; only billing is new
- Most current subscribers are on Pro, so this is the main way existing
  customers buy Max. `CloudProPopup.tsx`'s "not self-serve yet" copy changes
  for the Max path.

## Testing

- **Admin:** tier gating (Max gets URLs; Free/Personal/Pro get the locked
  teaser), relay 402 without Max, 429 at the cap, machine-token and
  account-token paths, the catalog data file's schema test.
- **Desktop:** teaser vs connectable rendering; each auth kind's connect flow;
  the relay credential never written to `config.json`, logs or the renderer
  (redaction test); the new server limit; Files in the More menu; All view
  Science section; "Connect the 5 public databases".
- **Live:** each vendor entry signs in end to end with a real account before
  it ships (see the inclusion rule); each hosted server answers through the
  relay.
- Verify the desktop UI in an isolated fixture (`scripts/control-omb.ts ui
  launch`) and an OMB2 side-by-side build, never the installed app or its
  data.

## Delivery

Three PRs, each its own branch and worktree; nothing pushed without Omkar's
go-ahead:

1. openmaus-cloud: `science` tier allowance, catalog routes and data file,
   science relay + cap, desktop relay-token route, home secrets, self-serve
   plan change to Max.
2. Hosting for the five science servers (repo and host chosen by the
   builder).
3. OpenMausBot desktop: the Science filter and tiles, teaser copy, the `cloud`
   and `tenant` auth kinds, catalog transport through Electron main, server
   limit.

No phone changes.

## Left to the builder

- Choice between the candidate PubMed/Clinical Trials servers; the ChEMBL and
  bioRxiv tool set (search plus lookup by id is enough for v1).
- Where the five servers run and how the relay reaches them.
- Exact copy polish within the strings above; i18n keys in `en.json` only.

## Calls made in the design, not by Omkar

- "Science" as the filter name (fits one line); Files moved into More.
- Grouping by research task, not by price; the tag names.
- Server limit raised to 50; Max cap of 20,000 science calls a month; Max
  trials get a pro-rated share.
- A bundled teaser limited to the launch set.
- Amass left out (purpose not verified).
