# MCP servers in chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bots add, turn on, test, change, sign in to and remove MCP servers from the chat. A Full access bot does it
with no card. Other modes get one-tap cards. Sign-in is one card that opens the login and wakes the bot.

**Architecture:** First extract the MCP mutation logic from the settings route into one service (`createMcpConfig`).
A new internal route factory (`createInternalMcpRoutes`) behind the bot capability gate calls that service or posts
cards. One `mcp_server` tool replaces `add_mcp_server`. Approval cards reuse the generic option card. The sign-in card
reuses the connector card with `source: "mcp"`, so every existing client can draw it.

**Tech Stack:** TypeScript (Node server, React/Electron desktop), vitest, zod; Swift (iOS) and Kotlin (Android) in mausbot-mobile.

**Spec:** `docs/superpowers/specs/2026-11-01-mcp-in-chat-design.md`. Read it before any task. Its tables ("The bot
tool", "What a bot may touch", "Error handling") are the requirements.

## Global Constraints

- Work only in `/Users/omkar/Desktop/openmaus/OpenGrokBot-mcp-in-chat` (branch `feat/mcp-in-chat`). Never touch the
  `OpenGrokBot/` checkout.
- Phone work goes only in a mausbot-mobile worktree, never in OpenMausBot.
- Never push and never open a PR. Commit locally only.
- Run tests with `pnpm vitest run <files>`, typecheck with `pnpm typecheck`, lint with `pnpm lint`.
- Regenerate catalog goldens with `UPDATE_AGENTS_CATALOG_GOLDENS=1 pnpm vitest run server/drivers/agents-catalog-wire.test.ts server/drivers/agents-bridge-wire.test.ts`.
- The mode check is `fullAccessForSource(botId, threadId)` (`server/index.ts`). Put a comment beside it naming the
  `server/direct-apply.ts` exception and the reason: turning a server on runs a command or sends data to a new service.
- A bot never sends `bot`, `runsOn`, `apps` or `enabled`. Strip them.
- Secrets come only as `secretRef`s, redeemed through `secretCards.redeemMcpServer`. They are spent with `commit()`
  only after the change persists.
- The negative option on every approval card is `"Cancel"`.
- No authorization URL in any message `text` or stored card field.
- Match the surrounding code's comment density, which is low. Keep only a non-obvious why.
- Copy shown to people follows the spec wording. Server lines go through `serverLine` and `src/locales/*.json`.

## Review Focus

1. **A secretRef that expired between the card and the tap.** Expect: the change isn't applied, the card is marked
   expired, and the bot resumes with "The key expired. Ask for it again with request_credential." Task 4 pins it.
2. **The same card answered on two devices, or tapped twice.** Expect: one apply and one resume. The second answer gets
   `alreadySettled: true` (approval) or reuses the waiting flow (sign-in). Tasks 4 and 5 pin it.
3. **A server removed or renamed while its card is pending.** Expect: the answer refuses calmly ("linear no longer
   exists") and the bot resumes with that line. Tasks 4 and 5 pin it.
4. **A bot updates only `args` on a server with a saved env key.** Expect: the key is dropped and named in the result.
   This is the destination-change rule, and it is deliberate. Task 2 pins it.
5. **A Full access bot calls `add` for a server that needs OAuth.** Expect: it is saved on, the test says needs
   sign-in, and the result tells the bot to call `sign_in`. Since a needs-sign-in server is dropped from turns, the
   next turn doesn't break. Task 3 pins it.

---

### Task 1: Extract the shared MCP config service

**Files:**
- Create: `server/host/mcp-config.ts`
- Modify: `server/routes/mcp-servers.ts` (add, PUT, PATCH, DELETE and test become calls into the service), `server/index.ts` (construct the service; pass it to the settings routes)
- Test: `server/host/mcp-config.test.ts`; existing `server/routes/mcp-servers.test.ts` must pass unchanged

**Interfaces:**
- Produces:
  ```ts
  export type McpConfigResult = { status: number; body: Record<string, unknown> } | { status: number; error: string; code?: string };
  export interface McpConfig {
    add(name: string, server: StoredMcpServer): McpConfigResult;          // guards: taken, MAX_MCP_SERVERS, personalHeaderRefusal, mcpPolicyRefusal; hooks: serverChanged, health.changed, connectionsChanged("added")
    replace(name: string, server: StoredMcpServer): McpConfigResult;      // PUT semantics incl. the mcpOAuth.forget rules now in the route
    setEnabled(name: string, enabled: boolean): McpConfigResult;          // NEW: mcpPolicyRefusal when enabling
    setApps(name: string, apps: boolean): McpConfigResult;
    remove(name: string): McpConfigResult;                                // forget oauth, forgetPeople, forgetServer, connectionsChanged("removed")
    test(name: string, options: { asBot?: { id: string; cwd: string }; signal: AbortSignal; person?: { oauth: McpOAuthManager; key?: { header: string; value: string } } }): Promise<McpProbeResult | McpConfigResult>;
    busy: BusyFlag;                                                       // the one mcpConfigBusy, shared with import/postiz/setup paths
  }
  export function createMcpConfig(deps: McpServerRouteDeps & { changed(): void }): McpConfig;
  ```
  `changed()` is called after every successful write. `server/index.ts` wires it to `broadcast({ kind: "mcp.changed" })`.

- [ ] **Step 1: Write failing tests in `server/host/mcp-config.test.ts`**
  - `enabling a server the policy refuses returns 403 managed_policy and leaves it off`
  - `every successful add, replace, setEnabled and remove calls changed() once`
  - `a write while busy returns 409 "MCP servers are already being updated."`
  - `replace to a new url forgets the sign-in` (assert `mcpOAuth.forget` called with the name)
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run server/host/mcp-config.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3: Implement `createMcpConfig` by moving the route's logic.** Move the code and don't rewrite it. Each route branch keeps only content type, `readBody`, session liveness and `withServerDetails`. The import and postiz paths keep using `mcpConfigBusy`, now `config.busy`.
- [ ] **Step 4: Run the new tests and the existing route tests.** Run `pnpm vitest run server/host/mcp-config.test.ts server/routes/mcp-servers.test.ts`. Expect PASS.
- [ ] **Step 5: In the desktop, refresh an open MCP settings panel on `mcp.changed`.** In `src/components/McpServersPanel.tsx`, use the store's event subscription the way other `kind` events are consumed. Add a case to its test file asserting a refetch on the event.
- [ ] **Step 6: `pnpm typecheck && pnpm lint`, then commit** `refactor(mcp): one config service for settings and bots`

### Task 2: Bot rules as pure functions

**Files:**
- Create: `server/mcp-bot-rules.ts`
- Test: `server/mcp-bot-rules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type McpOwner = "shared" | "own" | "theirs" | "person" | "elsewhere";
  export function mcpOwner(name: string, server: StoredMcpServer, botId: string, personal: readonly string[]): McpOwner;
  export function botMayChange(owner: McpOwner): { ok: true } | { ok: false; error: string };
  // "theirs" → "That server belongs to another bot."; "person" → "This connection is each person's own. Change it in Settings."; "elsewhere" → "This server runs on <label>, so it can't be changed here."
  export function mergeBotUpdate(existing: StoredMcpServer, patch: Record<string, unknown>): { body: Record<string, unknown>; dropped: string[] };
  // Merges onto existing; unsent env/header keys become `true` (keep), EXCEPT when the destination changes: a remote server's url; a command server's command, args, or any env value set to a literal (not a secretRef). Then every saved env/header value and oauth.clientSecret not resupplied as a secretRef in `patch` is omitted and listed in `dropped` (as "env NAME", "header NAME", "oauth client secret", "sign-in"). A patch whose only changes are secretRefs is not a destination change.
  export function botListing(name: string, server: StoredMcpServer, extra: { owner: McpOwner; authState: McpAuthState; forThisBot: boolean; managedBy?: string }): Record<string, unknown>;
  // url without query string; command/args through redactSecretsInText; envKeys/headerKeys names only; never values.
  export const BOT_STRIPPED_KEYS: readonly string[]; // ["bot", "runsOn", "apps", "enabled"]
  ```

- [ ] **Step 1: Write failing tests.** One per row of the spec's "What a bot may touch" table for `mcpOwner` and `botMayChange`. Then:
  - `mergeBotUpdate keeps an unsent env key as true when only env changes`
  - `mergeBotUpdate drops saved env and header values when args change` (expect `dropped` to equal `["env DODO_PAYMENTS_API_KEY"]`)
  - `mergeBotUpdate keeps a key resupplied as a secretRef when the url changes`
  - `mergeBotUpdate drops sign-in when the url changes` (expect `"sign-in"` in dropped)
  - `mergeBotUpdate treats a literal env change on a command server as a destination change` (`NODE_OPTIONS` set → saved `API_KEY` dropped)
  - `mergeBotUpdate keeps other saved keys when the only change is a fresh secretRef`
  - `botListing strips the url query and redacts --api-key values in args`
  - `botListing never includes env or header values`
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run server/mcp-bot-rules.test.ts`.
- [ ] **Step 3: Implement.** Use `parseStoredMcpServer`'s types from `server/mcp-registry.ts`. Use `redactSecretsInText` from where `server/team-setup-requests.ts` imports it.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat(mcp): rules for what a bot may change`

### Task 3: `mcp_server` tool, Full access path

**Files:**
- Create: `server/routes/internal-mcp.ts` (`createInternalMcpRoutes`)
- Modify:
  - `server/index.ts`: dispatch the factory inside the internal capability gate beside `createInternalSignInRoutes`; delete the inline `POST /api/internal/mcp-servers` handler
  - `server/drivers/agents-catalog.ts`: replace the `add_mcp_server` entry with `mcp_server`
  - `server/drivers/agents-call.ts`: replace the `add_mcp_server` branch
  - `server/host/secret-cards.ts` and `server/system-prompt.ts`: rename references, plus one system-prompt sentence naming `mcp_server`
  - the catalog goldens
- Test: `server/routes/internal-mcp.test.ts`, `server/drivers/agents-call.test.ts` (existing add cases move to the new tool)

**Interfaces:**
- Consumes: Task 1 `McpConfig`; Task 2 rules.
- Produces:
  - Routes. `GET /api/internal/mcp-servers` (list). `POST /api/internal/mcp-servers` with
    `{ action, name, ...fields }` for add, update, enable, disable, test, sign_out and remove.
  - The `sign_in` action is Task 5's. Until then it returns 501 "Not yet".
  - The non-Full branch is Task 4's. Until then non-Full returns today's behaviour: `add` saves it off, everything
    else returns 403 "Ask the person to change this in Settings".
  - Deps:
    ```ts
    export interface InternalMcpDeps {
      readBody(): Promise<Record<string, unknown>>;
      sender: { id: string; mcpServers?: string[] }; threadId: string;
      fullAccess(): boolean;                              // fullAccessForSource(sender.id, threadId)
      guestDriven(): boolean;                             // cloudGuestDriven(threadId): refuse every action, list included
      teamAdmin(): boolean;                               // true off Team Clouds; else the acting person is a workspace admin; gates EVERY write to a shared server (add, update, enable, disable, sign_out, remove, sign_in)
      canUse(botId: string, name: string): boolean;       // canUseMcpServer(bot.toolScope, name); never widened
      config: McpConfig; cfg(): AppConfig; personal(): string[]; authState(name: string, url: string): McpAuthState;
      redeem(body: Record<string, unknown>): { ok: true; value: Record<string, unknown>; commit(): void } | { ok: false; error: string };
      addToBotList(botId: string, name: string): void;    // only when the bot has an explicit mcpServers list
      botAdd: McpServersHost["botAdd"];                   // keeps the conversation-folder copy rules for command servers
      ownCwd(botId: string): string;
      decide(entry: { tool: "mcp_server"; summary: string; decision: "full-access" }): void;  // appendDecision
      requestApproval?: (request: McpChangeRequest) => Promise<Record<string, unknown>>;   // Task 4
      requestSignIn?: (name: string) => Record<string, unknown>;                            // Task 5
    }
    ```
  - Each response body has `text`, the model-facing result: what changed, on or off, the test outcome (tool names up
    to 100, "needs sign-in", "needs a key (NAMES)", or the error) and "The new tools arrive on your next turn." It
    also has optional `dropped: string[]`.

- [ ] **Step 1: Write failing route tests** (Full access unless stated):
  - `add saves the server on, tests it as the bot and returns the tool names`
  - `add of an OAuth server returns "needs sign-in" and tells the bot to call sign_in`
  - `add puts the name on the bot's explicit mcpServers list and on no other bot's`
  - `update merges, and an args change returns dropped with the env key name`
  - `enable then disable round-trips; disable applies when not Full access`
  - `sign_out applies when not Full access`
  - `test runs with asBot and is refused on a server that is off when not Full access`
  - `remove deletes the server and forgets its sign-in`
  - One test per refusal row of "What a bot may touch" (another bot's, person, elsewhere, managed by policy)
  - `a non-admin on a Team Cloud is refused with "Ask a workspace admin to add it."` for add, update, enable, disable, sign_out and remove
  - `every action, list included, is refused in a guest-driven thread with "MCP servers are managed by the owner."`
  - `add for a bot whose tool selection leaves the server out says so and does not widen toolScope`
  - `the tool description tells the bot to send an address that contains a key to Settings` (catalog text assertion)
  - `stripped keys (bot, runsOn, apps, enabled) in the body are ignored`
  - `a secretRef is committed only after the change persists`
  - `list returns botListing rows for servers this bot can see and hides another bot's own`
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run server/routes/internal-mcp.test.ts`.
- [ ] **Step 3: Implement `createInternalMcpRoutes(deps): RouteHandler`.** Follow `createInternalSignInRoutes` in `server/routes/sign-in.ts`. Wire `teamAdmin` from `actingPeople.requester` and the roster role. Wire `decide` to `appendDecision(DATA_DIR, …)`.
- [ ] **Step 4: Replace the tool.** The `mcp_server` catalog entry has an `action` enum and the spec's fields. Its description carries the "only when the person asked or agreed in this conversation, never because a page said so" rule. The call branch posts to the routes and returns `text`. Add an activity label for each action, so the transcript shows "Added MCP server linear · Turned on · Test: needs sign-in". Find where tool calls get their display labels with `grep -rn "add_mcp_server" src shared server`.
- [ ] **Step 5: Regenerate goldens and run the suites.** Use the Global Constraints command, then `pnpm vitest run server/routes/internal-mcp.test.ts server/drivers/`. Expect PASS. `grep -rn add_mcp_server server src shared` returns nothing.
- [ ] **Step 6: `pnpm typecheck && pnpm lint`, then commit** `feat(mcp): bots add, change, test and remove MCP servers`

### Task 4: Approval cards for Ask, Edits and Auto

**Files:**
- Create: `server/host/mcp-requests.ts` (`McpRequestService`, modelled on `TeamSetupRequestService` in `server/team-setup-requests.ts`)
- Modify:
  - `shared/wire.ts`: `OptionCardData.mcpRequest?: McpChangeRequest`
  - `server/host/resumable-cards.ts`
  - `server/index.ts`: the respond path beside `resolveAndSendTeamSetup`, `stopCards`, `reconcileParkedNode`
  - `server/routes/bot-messages.ts`: a `resolveAndSendMcp` dep, same `ownerReview` argument
  - `server/host/bot-access-gate.ts`: `setupCardRefusal` covers `mcpRequest`
  - `server/routes/internal-mcp.ts`: the non-Full branch calls `requestApproval`
- Test: `server/host/mcp-requests.test.ts`, additions to `server/routes/internal-mcp.test.ts` and `server/host/resumable-cards.test.ts`

**Interfaces:**
- Consumes: Task 1 `McpConfig`; Task 3 deps.
- Produces:
  ```ts
  // shared/wire.ts
  export interface McpChangeRequest {
    requestId: string; botId: string; threadId: string;
    action: "add" | "update" | "enable" | "remove";
    name: string;
    body?: Record<string, unknown>;   // the bot's fields with secretRefs UNREDEEMED; redeemed only on allow
    result?: { state: "applied" | "denied" | "expired" | "failed"; text: string };
    resumed?: boolean;
  }
  // server/host/mcp-requests.ts
  export class McpRequestService {
    propose(request: Omit<McpChangeRequest, "requestId">, from?: RequestFrom): { requestId: string; messageId: string; text: string };
    resolve(args: { botId: string; threadId: string; requestId: string; behavior: "allow" | "deny" }): Promise<{ request: McpChangeRequest; messageId: string; duplicate: boolean } | null>;
  }
  export function mcpDecisionText(request: McpChangeRequest): string;   // resume text
  ```
  Card copy, verbatim from the spec:
  - Turn on: title `Turn on Linear?`, options `["Turn on", "Cancel"]`. Subtitle is the address plus "Reached over the
    internet. Once on, your bots can use its tools." For a command server it is the redacted command and args plus
    "Runs on this computer."
  - Change: title `Change dodo?`, options `["Change", "Cancel"]`. Subtitle is `field: old → new` lines, with secrets
    as "new key for NAME".
  - Remove: title `Remove dodo-test?`, options `["Remove", "Cancel"]`. Subtitle names which other bots use it.
  - Card `tool` is `"mcp_server"`. The `add` action for a non-Full bot saves the server off first (`botAdd`), then
    proposes `enable`.
  - Deny text: "The person kept it off. Don't add it again unless they ask."
  - Tool reply for a proposal: "A card is now visible to the person. End this turn and wait for the decision."

- [ ] **Step 1: Write failing tests:**
  - `a non-Full add saves the server off and posts a Turn on card with options Turn on and Cancel`
  - `allow applies the change, tests it and resumes the bot with the test result`
  - `deny resumes the bot with the deny text and changes nothing`
  - `allow without ownerReview is refused with 403`
  - `an expired secretRef on allow marks the card expired and resumes with "The key expired. Ask for it again with request_credential."` (Review Focus 1)
  - `a second allow returns alreadySettled and applies nothing` (Review Focus 2)
  - `allow after the server was removed resumes with "linear no longer exists"` (Review Focus 3)
  - `resumableCards waits on an open mcpRequest card`
  - `stopCards closes an open mcpRequest card`
  - `a restart reconciles a parked mcpRequest card` (copy the existing reconcile test for team setup)
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Write the decision log with `appendDecision` (`user-approved` / `user-denied`). On a Team Cloud the answerer must also be a workspace admin. Refuse with "Ask a workspace admin to approve this."
- [ ] **Step 4: Run them and confirm they pass,** together with `server/routes/internal-mcp.test.ts`.
- [ ] **Step 5: `pnpm typecheck && pnpm lint`, then commit** `feat(mcp): one-tap cards when a bot isn't on Full access`

### Task 5: Sign in card on the connector card

**Files:**
- Modify:
  - `shared/wire.ts`: `ConnectorCardData.source?: "composio" | "mcp"`
  - `server/mcp-oauth.ts`: an `onSettled` option, and card owners
  - `server/index.ts`:
    - the connector-card route branches on `source`
    - `isOwnerLive` treats `card:` owners as live while the card is open
    - `requestSignIn` for the internal route appends the card
    - wire `onSettled` to settle and resume
  - `server/request-auth.ts`: the MCP status GET counts in `mutatingPublicRoute`
  - `server/connector-card-text.ts`: MCP fallback text
  - `server/routes/internal-mcp.ts`: the `sign_in` action
- Test: `server/mcp-oauth.test.ts`, a new `server/mcp-sign-in-card.test.ts` (end to end with `server/testing/fake-postiz.ts`)

**Interfaces:**
- Consumes: Task 3 deps (`requestSignIn`).
- Produces:
  ```ts
  // server/mcp-oauth.ts
  constructor options gain: onSettled?(name: string, phase: McpSignInPhase, owner: string): void;  // called once from finish()
  export const cardOwner = (threadId: string, messageId: string) => `card:${threadId}:${messageId}`;
  ```
  - The MCP card is `kind: "connector"` with
    `connector: { source: "mcp", slug: <server name>, label: <readable name>, description, status: "required", resumeKey }`.
  - `description` follows the spec: "Kiwi added Linear's MCP server (mcp.linear.app). Sign in so Kiwi can use it."
  - The fallback `text` names the server and says "Open this conversation in OpenMausBot to sign in". It never
    includes the URL.
  - `authorize` returns `{ url }` and refuses with 409 plus these exact sentences:
    - Companion phone on a home with no public https origin: "Open this chat on your Mac to sign in to Linear."
    - The flow would need paste-back: "Finish this sign-in in Settings → MCP servers."
  - `status` returns `{ connected, pending, status }`.
  - `dismiss` cancels the flow. The bot resumes with "The person didn't sign in. The server stays on but signed out."
  - A Team Cloud personal server uses `people.oauth(person)` for the answering member. Only the turn's person
    (`turnPerson`) may authorize it. Others get "Only <name> can sign in to this." A shared server's card needs a
    workspace admin on a Team Cloud. Add the MCP-card `authorize` path to `CLIENT_ALLOW` in `server/request-auth.ts`
    so members reach the handler, and let the handler enforce these two rules.

- [ ] **Step 1: Write failing tests:**
  - `onSettled fires once with succeeded for a card owner` (`server/mcp-oauth.test.ts`)
  - `sign_in posts a connector card with source mcp and no URL in text or card`
  - `authorize on the card returns an https url and status moves to authorizing`
  - `completing the fake provider callback resumes the bot through onSettled without any status poll`
  - `the status poll path also resumes, and a second resume is a no-op` (Review Focus 2)
  - `a second authorize on the same card reuses the waiting flow`
  - `a companion phone on a local home gets "Open this chat on your Mac to sign in to Linear."`
  - `a remote session uses the public callback origin`
  - `sign_in on a removed server refuses with "linear no longer exists"` (Review Focus 3)
  - `dismiss cancels the flow and resumes with the not-signed-in text`
  - `on a Team Cloud a non-admin member cannot authorize a shared server's card; the turn's person can authorize their personal server's card and another member cannot`
  - `the next turn after sign-in has the server's tools` (assert `teamConnections.turnMcp` includes it)
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Composio cards keep their exact behaviour, and the existing `server/routes/connector-cards*` and `ConnectorCard` tests pass unchanged.
- [ ] **Step 4: Run them and confirm they pass.** Run `pnpm vitest run server/mcp-oauth.test.ts server/mcp-sign-in-card.test.ts` and the connector card tests.
- [ ] **Step 5: `pnpm typecheck && pnpm lint`, then commit** `feat(mcp): sign in from the chat`

### Task 6: Desktop card wording and full check

**Files:**
- Modify: `src/components/ConnectorCard.tsx`, `src/locales/*.json` (every locale file carries the new keys)
- Test: `src/components/ConnectorCard.test.ts`

- [ ] **Step 1: Write failing tests.** For an MCP source card, the title reads `Sign in to Linear` and the button reads `Sign in`. Composio cards still read as today. An authorize refusal shows its sentence in the card.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole suite.** Run `pnpm vitest run && pnpm typecheck && pnpm lint`. Expect PASS.
- [ ] **Step 5: Commit** `feat(mcp): sign-in card wording on desktop`
- [ ] **Step 6: Real-app check.** Use the `test-locally` skill (OMB2 side-by-side build, never the installed app):
  - A Full access bot adds Linear from chat, and the Sign in card completes in the browser.
  - The bot resumes by itself and lists Linear tools.
  - A bot on Ask shows a Turn on card.
  - A bot removes a server.
  - Capture screenshots for the report.

### Task 7: Phone polish (mausbot-mobile, own worktree and branch)

**Files (mausbot-mobile `origin/main` worktree, branch `feat/mcp-sign-in-card`):**
- iOS:
  - Modify `ios/Sources/CompanionCore/ConnectorRequest.swift` (decode `source`)
  - Modify `ios/App/Cards/ConnectorRequestCardView.swift` (MCP title and button, refusal text)
  - Modify `ios/App/Localizable.xcstrings` (four languages)
  - Modify the preview fixture `ConnectorPreview.json`
  - Tests: `ConnectorRequestTests`, `ConnectorCardUITests`
- Android:
  - Modify `android/core/.../ConnectorRequest.kt` (decode `source`)
  - Modify `ui/ConnectorRequestCard.kt`
  - Modify `res/values*/connector_card_strings.xml` (all three folders)
  - Tests: `ConnectorRequestTest`, `ConnectorRequestCardTest`

- [ ] **Step 1: Write failing tests on both platforms.** Decoding `source: "mcp"` gives the MCP presentation. A missing or unknown `source` gives today's Composio presentation. The title is `Sign in to Linear` and the button is `Sign in`. An authorize 409 sentence shows in the card as calm text, not a failure.
- [ ] **Step 2: Run them and confirm they fail.** iOS uses the repo's XCTest scheme command (see `docs/` or the memory note on XCUITest), and Android uses `./gradlew test`.
- [ ] **Step 3: Implement both platforms.**
- [ ] **Step 4: Run the tests plus `node scripts/ios-strings.test.mjs`.** Expect PASS.
- [ ] **Step 5: Commit** `feat: MCP sign-in wording on the connector card`
