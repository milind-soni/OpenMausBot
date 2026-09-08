# Interactive replies

The web/desktop renderer recognizes `openmaus-ui` fenced blocks as OpenUI Lang.
The saved message holds the source and inline data. A bot can compose choices,
forms, calculations, charts, heatmaps and selectable process steps from the
public component catalog. This is a composable interpreter, not a fixed set of
complete templates. The agent receives the same contract through the common
system-prompt builder; no provider backend, model choice or authentication is
replaced.

## Architecture decision

### Existing cards and interaction routing

OpenMaus already renders onboarding choices through `OptionCard` and native
provider questions/approvals through its request flow. This contribution does not
introduce those capabilities or replace their request IDs, resume behavior, secure
credential entry, or confirmation boundaries.

The common system prompt prefers those existing paths when the agent needs an
answer to continue. Without a native question tool it asks in normal chat. OpenUI
is for local exploration with derived results, such as adjusting a time budget
and inspecting an estimate, or filtering a chart. A plain question with answer
buttons does not need a generated block. Never duplicate a pending native question
or represent permission/credential/profile/routine/skill confirmation through
OpenUI. A local draft remains an unsent composer draft, not a response to a brokered
request. The work-plan fixture demonstrates linked controls, preview and estimate.

- [Thesys OpenUI](https://github.com/thesysdev/openui): use the actual MIT-licensed
  `@openuidev/react-lang` and `@openuidev/lang-core` packages, pinned to 0.2.15.
  Its reactive bindings, expression interpreter and component catalog support
  local tools while OpenMaus owns the visual language and outward capabilities.
- [CopilotKit OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI):
  useful reference for sandboxed UI and a narrow host bridge. Its generated
  HTML/JS and agent backend are not imported.
- [W&B OpenUI](https://github.com/wandb/openui): a separate UI prototyping
  application, not the library behind openui.com. Its backend is not needed here.

The existing OpenMaus theme, typography and icons remain authoritative. Replies
use the conversation width with one calm panel, not another message bubble.
Grid columns are reserved for comparable Cards; mixed controls and derived
results automatically stay in a vertical flow. Metrics are compact inline
results. The system prompt teaches the same composition rules.

## Execution boundary

OpenUI runs in an offline bundle inside `iframe sandbox="allow-scripts"`, with
no `allow-same-origin`, popups, forms, top-level navigation, downloads or preload bridge.
Its CSP denies connections, images, fonts, media, frames and external scripts.
Only the trusted bundled runtime and CSS are inline. Generated data never becomes
HTML, JavaScript, CSS, a URL, a filesystem path or an event handler.

No OpenUI tool provider or action handler is installed. Source admission rejects
queries, mutations, action plans, unbounded Each expansion and execution-related identifiers outside quoted
data. Limits are 32 KiB per block, 64 declarations, 20 nesting levels and 4,096
reference-expansion steps. Cycles are rejected before the recursive parser runs.
Components validate their evaluated properties and bound their arrays/numbers.

The parent accepts only messages from the exact iframe window and per-mount
nonce. It accepts bounded local state, height, readiness/error, and a plain-text
draft. Draft cannot send messages, switch tasks, attach paths, navigate or call
tools. It uses the existing composer, preserving typed text, attachments and
channel delivery mode. The user reviews and sends the resulting draft normally.

The package is bundled with `NODE_ENV=production` even during development, so
OpenUI's automatically mounted CDN inspector is excluded. Observability publishing
is disabled. Runtime telemetry is not enabled; the iframe has no network access.
Installing dependencies need not run OpenUI's installation telemetry script.

## Persistence and limitations

Each block's local choices are stored on this device, keyed by task, message,
source offset and content fingerprint. Saved state is limited to 16 KiB. Reload
and task switching hydrate controls; editing a block starts fresh. If browser
storage is unavailable, the source/data still survive in message history and the
initial values remain usable. Control preferences are not synchronized to other
devices and are not inserted into the model context until added to a draft.

This catalog does not execute arbitrary HTML/JS, load remote data or create custom
components. Flow currently describes a sequence of selectable steps. A block's
viewport is capped at 1,600 px and larger content scrolls inside it. Parse failures
and unsupported components retain the source behind an explicit fallback.
Other clients that do not implement this fence see plain source, so the prompt
also requests an ordinary text summary. Provider-generated syntax quality varies;
the verification fixture uses a scripted Claude-compatible driver, not paid turns
through every supported engine.

## Reproduce

```sh
node --experimental-strip-types scripts/interactive-reply-fixture.ts
```

The launcher prints the exact URL/PID/data directory and persisted messages. Set
`OMB_PORT` to that port before starting `pnpm dev`, then open **Interactive Studio**.
Add `--include-errors` to include unsupported-component, invalid numeric range,
and mismatched chart/heatmap dimension fallbacks. Ctrl-C closes
only the fixture it launched. All example data is illustrative.

Verify choices, text entry, draft preservation and the absence of POST requests
when interacting. In the heatmap, a minimum of 8 leaves four cells. In the sample
comparison, 5 people with annual billing off produces a Team total of 100 USD.
Open the decision steps and select Budget. Switch tasks, reload, change skins and
repeat at 390 px. Mixed form controls must stack; only peer Cards get columns.
The source and reset actions are in the reply's options menu.

```sh
pnpm exec vitest run shared/interactive-reply.test.ts src/lib/interactive-state.test.ts src/lib/drafts.test.ts server/system-prompt.test.ts src/components/ChatMarkdown.test.ts
pnpm typecheck
```

Browser/package evidence additionally checks that the sandbox cannot access the
parent DOM, storage, Electron bridge or network. A green unit test or build is not
visual acceptance; record current screenshots and exercise the packaged app.

## Verification record

The verification fixture uses the scripted Claude-compatible driver and a
disposable data directory. It exercises this interactive-reply surface only;
it does not claim document-preview behavior or Windows custom-path behavior.

The focused checks completed on the feature branch:

- `pnpm exec vitest run shared/interactive-reply.test.ts src/lib/interactive-state.test.ts src/lib/drafts.test.ts server/system-prompt.test.ts src/components/ChatMarkdown.test.ts`: 5 files, 52 passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- Browser acceptance: choices, text entry, draft preservation without a POST,
  heatmap filtering, derived totals, selectable steps, reload hydration, skin
  changes, sequential mixed controls, mobile layout, and iframe isolation for
  parent DOM, storage, bridge, and network.
- Theme QA after the production bundle rebuild: the iframe reports `dark` for
  midnight, `light` for atelier, and `dark` after returning to midnight; the
  heatmap at slider 8 has four active cells.

The original before/after evidence used the same fixture state. The upstream comparison
at `http://127.0.0.1:5399` leaves the fenced source visible in the transcript;
the feature build at `http://127.0.0.1:5599` renders the controls and preserves
the draft in the composer. The checked-in screenshots are:

- [`interactive-upstream-source.png`](images/interactive-upstream-source.png)
- [`interactive-choices.png`](images/interactive-choices.png)
- [`interactive-actions.png`](images/interactive-actions.png)
- [`interactive-focus.png`](images/interactive-focus.png)
- [`interactive-heatmap-8.png`](images/interactive-heatmap-8.png)
- [`interactive-light.png`](images/interactive-light.png)
- [`interactive-mobile.png`](images/interactive-mobile.png)

The fixture is a deterministic renderer and safety check; it does not replace
paid-provider coverage or the separate packaged-desktop integration gate.

### Native interaction coexistence follow-up (2026-09-07)

The prompt now routes blocking questions and confirmations to the existing native
interaction paths. The work-plan example demonstrates a local calculation instead
of a standalone question. The six focused suites, including the existing Claude
native question/request tests, passed 123 tests with 2 platform skips. The production
build passed. A fresh isolated fixture at `http://127.0.0.1:22482` (PID 282504)
verified that 4 hours produces 12 estimated sections and updates the plan preview;
adding the draft produces no POST. Choice/input persistence, heatmap filtering,
comparison totals, steps, themes, mobile layout and sandbox boundaries also passed.
The choices, actions, focus, light and mobile screenshots now show this work-plan
fixture. The upstream-source and heatmap images retain their original evidence.
These scripted checks do not prove that every provider will follow the guidance.

### Render failure regression

`scripts/smoke-interactive-runtime.mjs` builds the actual production runtime and
runs it in fresh sandboxed browser frames. It requires the optional Playwright QA
tool; set `OMB_PLAYWRIGHT_MODULE` to an existing installation if it is not locally
resolvable, and optionally `OMB_BROWSER_CHANNEL=msedge` to use installed Edge.
No provider or user profile is used.

```sh
node --experimental-strip-types scripts/smoke-interactive-runtime.mjs
```

The eight cases cover three reactive examples, invalid numeric ranges, mismatched
chart/heatmap dimensions, and an injected render exception. Each failure must
report an error without a preceding ready event; a repeated init must replay that
error. The regression fails on `--runtime-ref 2df3d3be` with a false-ready outcome
and passes after the render boundary/readiness fix. In the isolated conversation
fixture, the five malformed blocks retain their source while the three healthy
blocks remain usable. Readiness is sent only after a successful React commit;
all parser, property and render failures update the cached handshake outcome.
