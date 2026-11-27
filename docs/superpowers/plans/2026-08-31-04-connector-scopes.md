# Connector Scopes (Connections Center, part 2) Implementation Plan

> **Superseded.** The per-bot grants this plan sketched shipped as exact tool
> names rather than verb classes, tracked in umbrella issue [#1734](https://github.com/milind-soni/OpenMausBot/issues/1734)
> (data model #1756, harness verdict #1761, web grant editors #1814, mobile
> surfacing + docs #1739). Everything below is kept for history; the P4
> constraints it named still hold and were carried forward: imports land with
> no grants, refusals never enumerate adjacent grants, every allow/deny
> writes a decision-log row, exports never carry grants.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `bot.composio` boolean with per-bot connector grants — which service, which connected account, and which verb class (read, draft, send, modify, delete) — enforced on the Composio bridge rather than trusted to the model.

**Architecture:** Composio tool names are verb-shaped (`GMAIL_FETCH_EMAILS`, `GMAIL_SEND_EMAIL`, `GITHUB_DELETE_REPO`). A pure classifier maps a tool name to a verb class; the per-tool gate built in P3 Task 3 refuses a call whose class is not granted. Account selection rides in the bridge's env, so a bot with the "work" Gmail cannot reach the "personal" one.

**Tech Stack:** TypeScript, Node 24, Vitest, React.

**Spec:** none — this plan is its own spec.

## Global Constraints

See [the roadmap](2026-08-31-00-control-plane-roadmap.md#global-constraints). Load-bearing:

- **Imports land disabled.** `server/store.ts:340` already encodes the important half of this: an imported team member starts `composio: false` so a shared persona cannot reach the user's Gmail on turn one. Scopes must not weaken it — an imported bot starts with **no grants**, not with read.
- **Audit what you authorize.** Every refusal writes a `decision-log` row.

**Depends on:** [P3](2026-08-31-03-mcp-registry.md), specifically Task 3's `CallVerdict` gate signature.

---

## Background

`BotRecord.composio` (`server/store.ts:345`) is a single boolean: unset or true means
this bot may use every connected app with every tool; false means none. Meanwhile
`ConnectorStatus.accounts[]` already exists in the UI type
(`src/components/PluginsPanel.tsx:26`) and `normalizeAccountAlias`
(`server/composio.ts:257`) and `removeAccount` (`:656`) already manage multiple accounts
per service. The data model supports multi-account; nothing assigns them.

---

## File map

- Create `server/connector-scopes.ts`: the pure tool-name to verb-class classifier and grant evaluation.
- Create `server/connector-scopes.test.ts`.
- Modify `server/store.ts`: `BotRecord.connectorGrants`, keep `composio` as a derived legacy read.
- Modify `server/composio.ts:348` (`mcpIntegration`): carry the account and scope policy into the bridge env.
- Modify `server/index.ts`: grant endpoints; wire the gate.
- Modify `server/profile-document.ts`: surface grants in the profile (P2).
- Modify `src/components/ConnectorCard.tsx`, `src/components/PluginsPanel.tsx`: the grant editor.

---

### Task 1: The verb classifier

**Files:**
- Create: `server/connector-scopes.ts`, `server/connector-scopes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ConnectorScope = "read" | "draft" | "send" | "modify" | "delete";
  export const CONNECTOR_SCOPES: readonly ConnectorScope[];
  export function classifyTool(toolName: string): ConnectorScope;
  ```

- [ ] Write failing tests pinning the classification of real Composio tool names: `GMAIL_FETCH_EMAILS` → `read`; `GMAIL_LIST_THREADS` → `read`; `GMAIL_CREATE_EMAIL_DRAFT` → `draft`; `GMAIL_SEND_EMAIL` → `send`; `SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL` → `send`; `GITHUB_UPDATE_A_REPOSITORY` → `modify`; `GITHUB_DELETE_A_REPOSITORY` → `delete`; `NOTION_ADD_PAGE_CONTENT` → `modify`.
- [ ] Write the test that matters most: **an unrecognized tool name classifies as `delete`**, the most restrictive class. A classifier that defaults to `read` turns every tool it has not seen into an ungated read. Assert `classifyTool("ACME_FROBNICATE_WIDGET") === "delete"`.
- [ ] Write a failing test that classification is case-insensitive and tolerates the `_A_`/`_THE_` filler Composio's generated names contain.
- [ ] Run `pnpm vitest run server/connector-scopes.test.ts`; expect FAIL.
- [ ] Implement as an ordered list of matchers checked most-destructive-first (`DELETE|REMOVE|DESTROY|ARCHIVE|TRASH` → delete, then `SEND|POST|PUBLISH|REPLY` → send, then `DRAFT` → draft, then `UPDATE|CREATE|ADD|MOVE|SET|PATCH` → modify, then `GET|LIST|FETCH|SEARCH|READ|FIND` → read, else delete). Order matters: `GMAIL_CREATE_EMAIL_DRAFT` must reach the draft matcher before the modify matcher, so draft precedes modify and both follow send.
- [ ] Run; expect PASS.
- [ ] Commit `feat(connectors): classify connector tools by verb class`.

---

### Task 2: Grants on the bot

**Files:**
- Modify: `server/store.ts:340-345`
- Modify: `server/connector-scopes.ts`, `server/connector-scopes.test.ts`
- Test: `server/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ConnectorGrant { accountId?: string; scopes: ConnectorScope[] }
  // BotRecord.connectorGrants?: Record<string /* slug */, ConnectorGrant>
  export function evaluateConnectorCall(
    grants: Record<string, ConnectorGrant> | undefined,
    slug: string,
    toolName: string,
  ): CallVerdict;
  ```
  `CallVerdict` is P3 Task 3's type, imported from `server/mcp-bridge.ts`.

- [ ] Write failing tests: a bot granted `{ gmail: { scopes: ["read"] } }` may call `GMAIL_FETCH_EMAILS` and is refused `GMAIL_SEND_EMAIL` with a message naming the tool and the missing class; a bot with no grants is refused everything; a bot granted a service is still refused a **different** service's tools.
- [ ] Write a failing test for the migration: a `BotRecord` with legacy `composio: true` and no `connectorGrants` reads as **full grants on every connected service**, so an existing workspace does not silently lose its connectors on upgrade; a legacy `composio: false` reads as no grants.
- [ ] Write a failing test that the refusal text is safe to hand to a model — it names the tool and the missing scope, and tells it to ask the person, but does not enumerate what the bot *could* do. A refusal that lists the adjacent grants teaches the model to probe.
- [ ] Run; expect FAIL.
- [ ] Implement `evaluateConnectorCall` and the migration read. Keep `BotRecord.composio` in place as the legacy field; add a comment marking it superseded and pointing at `connectorGrants`. Do not delete it in this plan — the companion sidecar allowlist and the team-import path both read it, and untangling them is a separate change.
- [ ] Run; expect PASS.
- [ ] Commit `feat(connectors): per-bot service, account, and scope grants`.

---

### Task 3: Enforce on the bridge

**Files:**
- Modify: `server/composio.ts:348` (`mcpIntegration`)
- Modify: `server/index.ts` (turn assembly)
- Test: `server/composio.test.ts`, `server/index.test.ts`

- [ ] Write a failing test that `mcpIntegration` carries the bot's grants and selected account ids into the bridge process **via env**, never argv, and that the resulting env contains no Composio API key beyond the one already required.
- [ ] Write a failing test at the API level: a bot granted only `read` on gmail has its `GMAIL_SEND_EMAIL` call refused by the bridge, and a `decision-log` row is appended with `kind: "user-denied"` and a new `DecisionSource` of `"connector-scope"`.
- [ ] Write a failing test that a bot with two Gmail accounts connected and `accountId` set to the work account cannot reach the personal one — assert on the account id the bridge forwards, not on the tool name.
- [ ] Run; expect FAIL.
- [ ] Wire `evaluateConnectorCall` into the Composio bridge through P3 Task 3's `verdict` hook. Add `"connector-scope"` to `DecisionSource` in `server/decision-log.ts`.
- [ ] Run `pnpm vitest run server/`; expect PASS.
- [ ] Commit `feat(connectors): enforce scopes and account selection on the bridge`.

---

### Task 4: The grant editor

**Files:**
- Modify: `src/components/ConnectorCard.tsx`, `src/components/PluginsPanel.tsx`
- Test: `src/components/ConnectorCard.test.ts`

- [ ] Write a failing test for the pure summariser: `summariseGrant({ scopes: ["read","draft"] })` → `"Read and draft"`; all five scopes → `"Full access"`; empty → `"No access"`. This string is what a person scans down a list of bots, so it must never be a raw array.
- [ ] Run; expect FAIL.
- [ ] Implement. Add a per-bot row to each connected service card: an account selector when more than one account exists, and five scope checkboxes. Default a newly granted service to `read` only — the least surprising grant, and the one a person can widen deliberately.
- [ ] Show the legacy state honestly: a bot still on `composio: true` with no explicit grants renders as "Full access (legacy)" with a one-click action to narrow it. Do not silently migrate a live workspace to a narrower grant; show it and let the person choose.
- [ ] Run the focused test, `pnpm typecheck`, `pnpm check:contrast`.
- [ ] Commit `feat(connectors): scope and account editor per bot`.

---

## Self-review

**Coverage.** The community's "set permissions such as read, draft, send, modify, and
delete" and "connect multiple accounts and assign them per bot" are Tasks 1–4. "Show
where the connector runs and where data travels" is covered in P3 Task 7 for direct MCP;
for Composio the honest answer is one sentence on the card — it runs through Composio's
service — and that copy belongs in Task 4.

**Type consistency.** `ConnectorScope` and `classifyTool` (Task 1) feed
`evaluateConnectorCall` (Task 2), which is consumed by Task 3 through P3's `CallVerdict`.
`ConnectorGrant` is the stored shape in Tasks 2, 3, and 4.

**The risk worth naming.** Task 1's classifier is a heuristic over generated names from
a third-party catalog that changes without notice. It fails safe — an unknown name
classifies as `delete` and is refused unless the bot has full access — but that means a
new Composio tool can break a working read-only bot until the matcher list is extended.
That is the correct direction to fail, and Task 4's UI should surface the refusal clearly
enough that the cause is obvious. A follow-up could pull verb metadata from the toolkit
API instead of the name; that is worth doing only if refusals turn out to be frequent.
