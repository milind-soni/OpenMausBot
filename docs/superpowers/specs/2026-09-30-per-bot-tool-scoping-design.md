# Per-bot tool selection for local models

Design for [#2047](https://github.com/milind-soni/OpenMausBot/issues/2047).

## Purpose and acceptance

A Pi or Grok CLI bot using a local model should receive only the tools its
owner selected. A drafting bot can use its engine's read, edit, and write
tools without the computer or teammate catalogs. A mail bot can use a
selected custom MCP server without either built-in catalog. Individual
computer and teammate tools can also be selected.

The contribution must preserve existing bots, enforce selection before
schemas reach the model, and reject excluded calls even when the model
remembers a tool from an earlier turn. Selecting a tool does not approve
its execution or override existing computer, connector, managed-workspace,
guest, or human-approval restrictions.

Pi and Grok CLI are the first required live reproductions. The issue also
asks for a boundary across engines: the shared scope must reach every
registered adapter, with MCP enforcement and native enforcement treated
separately. Each adapter needs an explicit capability and a verified
native contract, or a visible refusal before a restricted turn starts.
An unsupported adapter must never silently ignore the selection. Such a
refusal is a safety fallback, not proof that usable native tool selection
has been delivered on that engine.

Completion requires an engine coverage table backed by adapter tests and
provider evidence. Do not declare the whole issue fixed by demonstrating
only Pi, only Grok's API driver, or only MCP schema filtering. If an external
engine cannot implement part of the proposal, document the exact contract
limitation and seek agreement on the contribution boundary before claiming
completion or closing the issue.

## Current evidence

- Upstream base: `90ffde779f787617d5d7b571e8c06646d09d7eb2`.
- Issue #2047 is open. No active overlapping implementation was found in
  the open-PR search on 2026-09-30. Recheck before publishing.
- Pi's adapter assembles the built-in MCP descriptors but omits
  `integrations.custom`; its extension registers every listed tool.
- Grok CLI mounts custom servers through ACP. Its native selection must
  use a verified ACP-compatible contract, not assumed headless flags.
- The existing result-budget gate is stdio-only and does not filter
  `tools/list` or `tools/call`. Its budget-zero escape hatch cannot become
  a way around tool selection.
- Existing connected-app grants and custom-server selection already have
  their own authority boundaries. They remain authoritative.
- The existing `verify-grok-images.ts` fixture passed on the installed Grok
  1.0.41 CLI using a disposable HOME and synthetic loopback completions.
  It proves that this real runtime can complete an isolated ACP turn without
  cloud credentials. It does not test tool selection or a real local model.
- The installed Codex 0.159.0 CLI exported its experimental app-server
  protocol schemas successfully under a disposable HOME. Thread start and
  resume accept configuration overrides; the exported protocol does not
  advertise a native tool allowlist field. `dynamicTools` adds tools and
  must not be mistaken for restricting the existing native catalog.

These observations establish the integration defects, not successful
execution of a fix. No new behavior has been implemented or validated yet.

## Alternatives and choice

1. **Shared selection with engine adapters and an MCP gate (chosen).** One
   persisted bot field expresses the owner's selection. Pi and Grok apply
   their own native contracts; the MCP boundary filters lists and calls.
   This avoids trusting prompts and keeps permission systems separate.
2. **Engine flags only.** Smaller initially, but cannot consistently scope
   MCP tools and risks Grok accepting flags that ACP does not apply.
3. **Tool search or lazy schemas only.** Reduces some prompt cost but does
   not express which tools a bot may use. It would change more provider
   behavior than this issue requires.

## Data contract

Add optional `toolScope` to the shared bot wire shape and turn input:

```ts
interface ToolScope {
  allow?: string[];
  deny?: string[];
}
```

Selectors name the original tool, before an engine rewrites its name:

- `native:read` for a Pi native or extension tool named `read`.
- `native:read_file` for the corresponding Grok tool.
- `native:*` for the engine's native and extension tools.
- `mcp:computer:<tool-name>` for one computer tool.
- `mcp:agents:<tool-name>` for one teammate tool.
- `mcp:fastmail:*` for the tools from the custom server named `fastmail`.

Only `native:*` and the final MCP tool wildcard have wildcard meaning.
There are no regular expressions or fuzzy, case-insensitive matches.
Server names use the existing validated MCP names. The original tool name
is the remainder after the namespace and server separator, preserving
literal punctuation. Engine aliases are never permission identities.

Semantics:

- Absent scope preserves current behavior.
- Absent `allow` permits existing tools except those matched by `deny`.
- Present `allow`, including an empty list, permits only its matches.
- A matching deny always wins.
- An empty `allow` means no tools; it must not mean inherit everything.
- Clearing the setting is an explicit authenticated owner action.
- Unknown selections never expand to all tools.
- Lists are bounded, deduplicated, and strictly validated. Reject unknown
  object fields, non-string entries, control characters, empty identities,
  and invalid wildcard placement.
- Corrupt persisted scope is retained as a deny-all state with a visible
  recovery error; it must not be discarded into the legacy all-tools default.

The pure parser and matcher live in a dependency-free shared module so the
standalone Pi helper and bundled server use the same semantics.

## Persistence and owner authority

Carry the field through bot loading, wire projection, PATCH, duplication,
and owner-created defaults. Export/import must preserve a restriction or
land disabled, following existing portability rules; an import must never
turn a restricted bot into unrestricted authority. Do not export credentials
or connected-app grants.

Bot-driven profile proposals cannot change tool scope. Existing authenticated
settings routes own this mutation. Reject changes while a bot has an active
turn, and recheck current bot/owner authority immediately before committing.
Resetting or widening a selection uses the existing trusted-setting boundary.

Snapshot the validated scope into every dispatch path, including room and
teammate turns. No direct, queued, resumed, or group path can omit it.

## Turn assembly and MCP enforcement

1. Apply current integration availability, computer-off, managed policy,
   server selection, and connected-app grants as today.
2. Remove a server when the scope cannot allow any of its tools. Use the
   available built-in teammate catalog to avoid mounting a denied agents
   server. A filtered discovery must not advertise an empty server catalog
   as useful tooling.
3. Give every remaining MCP server a scope-enforcing boundary. Filter all
   `tools/list` pages before schemas are handed to the engine. Preserve
   pagination and protocol errors without exposing withheld definitions.
4. Reject an excluded `tools/call` locally before the upstream sees it.
   Check raw server/tool identity, not a sanitized provider function name.
5. Apply the same rule to stdio, Streamable HTTP, and legacy SSE servers.
   Reuse the existing remote MCP client for a stdio facade; do not add a
   runtime dependency. Preserve authentication headers and cancellation.
6. An explicit scope requires the gate even with result budget zero.
   Malformed gate configuration terminates the restricted connection.
7. Credential-bearing configuration stays in the existing private config
   file or process environment. Never place it on argv or in diagnostics.

Catalog changes, malformed frames, unsupported transports, connection
failure, and alias collisions must not reopen access. Helpers dispose only
their own upstream processes and sessions.

## Pi integration

- Mount selected custom servers, including URL-backed servers through the
  shared facade. Declare custom-MCP capability only after this path works.
- Filter MCP tools before schema conversion and `registerTool`.
- Load the scope extension even when no MCP servers remain, because native
  tools still need filtering.
- Intersect the scope with Pi's active tools through the verified extension
  API before the first request and after session/model restoration. Never
  reactivate a tool another extension or Pi configuration disabled.
- Check the scope in the native `tool_call` hook and again in registered MCP
  execution. Tool aliases and package tools keep their original identities.
- Preserve the existing host-control confirmation. Custom MCP calls use the
  normal human approval path and do not become pre-approved.
- Missing extension enforcement API or malformed scope stops the restricted
  turn with a setup error before a provider request.

The exact supported Pi versions are determined by real CLI verification.
Current primary documentation describes active-tool and call hooks:
[Pi extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).
Do not infer support in an older installed runtime from those current docs.

## Grok CLI integration

Use a session-scoped, ACP-compatible native filter whose behavior is proven
with the installed official CLI. Grok profiles alone are insufficient if
an empty list means inherit-all or an unknown tool falls back to the full
catalog. The implementation must preserve an existing engine profile's
restrictions and intersect them with the bot's scope.

Verification must cover empty allowlists, unknown names, native execution
denial, MCP-only bots, and restored sessions. If a runtime cannot represent
the scope safely, reject the restricted turn before contacting the model
and explain the required runtime support. Do not silently approximate it.

The public source revision inspected during design is
`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; it is not the installed binary's
reported build revision. In that source, an empty profile allowlist inherits
all tools, and unresolved allowlist entries can preserve the full toolset.
Therefore forwarding arbitrary owner strings into that field is not a safe
implementation. The real-CLI contract tests must prove a strict alternative,
including preservation of any existing profile restriction. The repository
already depends on `yaml`; reusing it for profile parsing needs no new runtime
dependency if the selected contract requires temporary profiles.

Include scope in the ACP session fingerprint and apply it on both new and
resumed sessions. A changed scope must retire stale pooled tool state.
The shared MCP gate remains the authority for individual MCP calls.

Primary contracts to verify, with source revision recorded in test evidence:
[Grok agent profiles](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-agent/src/config.rs),
[Grok assembly filters](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-agent/src/builder.rs),
[Grok ACP guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md).

## Engine coverage and remaining contract work

The current registry contains 18 adapters. This inventory records existing
paths, not completed support for the proposed setting:

| Adapter(s) | Existing tool path | Required selection boundary |
| --- | --- | --- |
| Pi | RPC CLI plus the OMB MCP extension | Active native/package tools, native call hook, filtered custom and built-in MCP registration and execution |
| Grok CLI | ACP core plus Grok session/model configuration | Verified ACP native filter, fresh/resumed session checks, scoped MCP descriptors and calls |
| OpenAI compatible, Grok API, Mistral, MiniMax | Shared `openai-chat.ts` executor | Filter definitions before provider serialization, including the executor's question tool and leased cloud-computer tools; check calls before approval/execution |
| Claude | Per-process CLI native `tools` / `disallowedTools`, MCP configuration and permission callbacks | Intersect owner, instance, guest, and bot restrictions; filter all mounted MCP transports; reject excluded native calls |
| Codex | App-server configuration, MCP descriptors and approval requests | Verify native catalog controls against the installed app-server contract; preserve existing scoped computer overrides; filter MCP descriptors and calls |
| Gemini, Qwen, Kimi, Hermes, Droid, Cursor, OpenCode, Antigravity | Shared ACP core with provider-specific setup | Common MCP gate and session fingerprints; investigate each provider's native catalog controls and enforce or refuse unsupported restrictions explicitly |
| Custom ACP | User-supplied ACP process with no assumed native contract | Scope supplied MCP servers; require advertised/verifiable native selection support before accepting native restrictions |
| Boat native agent | Remote prompt API runs the whole turn on the leased computer | Verify the remote API accepts and enforces a tool subset; do not confuse shared chat computer tools with this remote-agent path |

Native-only selection and MCP-only selection must remain distinguishable.
A provider can apply MCP restrictions while retaining all native tools when
the scope explicitly allows those native tools. If the scope excludes a
native tool and the provider cannot enforce that exclusion before exposing
schemas and before execution, reject the turn with a named setup error.
Do not infer native restriction support from ACP permission prompts alone.

The final test matrix must enumerate these adapters rather than relying on
one shared-core test to claim every provider's native behavior works. Keep
provider credentials, native profiles, and ambient MCP servers out of the
isolated tests; inherited restrictions must still intersect with bot scope.

## Settings surface

Add a small Tool selection section to the existing bot Access settings.
Offer all current tools or a custom selection, with Allow and Exclude lists,
one identity per line. Show examples appropriate to the selected engine and
links to concise project documentation. Reuse the existing custom-server
selection card and existing save/error/busy behavior.

The UI must say that selection narrows available tools and that existing
approvals still apply. Preserve an explicit empty allowlist and clearly show
the no-tools state. Never label an unsupported engine as protected. Keep
technical selectors confined to this advanced setting; do not add onboarding,
new account flows, or automatic model downloads.

Capture before and after screenshots of the real isolated settings fixture.
Do not use live bot data, private accounts, or mock HTML as execution proof.

## Validation and release gates

Write behavioral regression tests before implementation:

- Legacy bots retain their previous catalog; an empty scope permits no tools.
- Deny precedence, raw-name collisions, unknown/malformed selections, and
  corrupt persisted configuration fail closed.
- Scope persists after restart and reaches direct and group turns.
- A mail-only Pi bot receives its custom MCP tools and no computer/agents
  schemas; a drafter receives only selected native tools.
- Real MCP fixtures paginate lists and record calls. A withheld call creates
  no upstream execution marker, for stdio and remote transports.
- Pi/Grok native enforcement is tested at the provider boundary and execution
  boundary, including resumed sessions and cancellation.
- Restricted catalog byte counts and tool counts are measured before/after
  with the same fixture. Estimates are not reported as measured tokens.
- Settings interaction saves the intended policy and handles errors, busy
  bots, and switching between bots without applying another bot's scope.

Run targeted tests first, then the required typecheck, lint, full tests,
Electron checks, locale checks for new strings, and fork CI. Reconcile any
baseline failure on unchanged main and document the exact evidence.

Live validation uses isolated HOME/data directories, disposable MCP tools,
and a small real local model. Complete actual Pi and Grok turns for a native
drafting task and a custom-MCP task. Record model/runtime versions, context
limit, exact schemas sent, results, and observed RAM usage. No user data or
cloud credentials are needed. Fake-engine proof is reported separately.

Before publishing, review the full diff for unrelated changes, generated
output, secrets, machine paths, dependencies, and release configuration.
Open a draft PR only when the supported behavior and evidence are reviewable;
attach it to the Codex task. Never merge it.

## Deliberately excluded

- A new onboarding flow, task-specific automatic tool discovery, or model
  routing and downloading UI.
- A shell/filesystem sandbox. Removing a tool is not a general OS sandbox.
- Redesign of connected-app grants, branding, or unrelated provider behavior.
- Unsupported native-provider guarantees or untested physical-device claims.
- Other projects' code, data, device shutdowns, or configuration without
  the owner's explicit authorization.
