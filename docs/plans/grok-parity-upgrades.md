# Grok Parity Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close eight behavioural gaps between OpenMausBot and the shipped
Grok Bot 0.18 runtime — bounded tool output, bot-block detection, a per-bot
action ledger, a general wake queue, event-listener triggers, executor
subagents, auto-review, and memory synthesis — without touching the
architecture that already works.

**Architecture:** Every item here is an *addition to an existing seam*, not a
new subsystem. Four seams carry the whole plan: the event bus
(`server/harness/bus.ts`), the `request.opened` fold (`server/index.ts:800`),
the connector-resume queue (`server/index.ts:2145`), and the harness-owned
MCP proxies (`server/computer-proxy.ts`, `server/drivers/agents-proxy.ts`).
Nothing in this plan changes the driver SPI, and no item requires a driver to
learn anything new.

**Tech Stack:** TypeScript (`--experimental-strip-types`), vitest, pnpm,
Electron + Vite. Tests: `pnpm vitest run <file>`; typecheck: `pnpm typecheck`.

**Spec:** This document. Design provenance is the reconstruction at
`github.com/b-nnett/grok-bot-0.18-reconstructed`, read for *contracts and
behaviour only* — it is reverse-engineered from a proprietary binary, so no
code, string, or generated protobuf from it may enter this repo. Every module
below is written from scratch against our own contracts.

## Global Constraints

- Node runs server TS directly via `--experimental-strip-types`; imports use explicit `.ts` extensions.
- Never break the one-file driver promise: a new provider is one file in `server/drivers/` plus one registration.
- Nothing is ever deleted from the store record; only model-facing rebuilds are bounded.
- `~/.openmausbot` is shared across app versions — every new field or message kind must be ignorable by an older build.
- All 150 existing test files must stay green (`pnpm test`).
- New on-disk artefacts are created `0600` (files) / `0700` (dirs) and pass through `redactSecrets` before they are written.
- No feature in this plan may be on by default on first run. Each ships behind a per-bot or global setting defaulting to off, except items 1.1–1.3 which are non-behavioural (bounding, detecting, recording).

---

## Working agreement — how this plan ships

Set by Omkar on 2026-08-24, and it overrides anything a sub-skill says about
finishing a branch.

1. **Nothing is pushed and no PR is opened, ever, until Omkar says so.**
   Not at the end of a task, not at the end of a round, not "ready for
   review". Work is committed locally on a branch; the handoff is the branch
   name and a sentence about what to look at. A one-off "raise the PR" for one
   round does not carry into the next.
2. **Every round ends at a build-and-test gate.** When the last task in a
   round is committed, build the app, hand Omkar a running dev app plus a
   short list of exactly what to exercise and what "working" looks like, and
   **stop**. No work starts on the next round until he says the current one is
   good.
3. **Fix-forward on the same branch.** Whatever he finds at the gate is fixed
   on that round's branch and re-gated — it does not become a follow-up item
   and it does not move to the next round.
4. **One branch per round**, cut from `origin/main` at the start of the round:
   `git checkout -b feat/parity-round-<n> origin/main`. `main` moves fast
   (hourly some days), so `git fetch` and check whether something in the round
   already landed before starting it.

### The gate, concretely

Dev app — the default, and what Omkar normally tests in:

```sh
# quit the installed OpenMausBot first: it holds port 8799 and shares ~/.openmausbot
pnpm typecheck && pnpm lint && pnpm test        # must be green before he is asked to look
pnpm dev:server                                  # terminal 1
pnpm dev                                         # terminal 2
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
```

`env -u ELECTRON_RUN_AS_NODE` is not optional — VS Code's shell exports
`ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node and exit.

Packaged app — only when he asks for it, or when a round touches packaging,
the updater, or a native helper (none of Rounds 1–3 do):

```sh
pnpm package:mac
rm -rf /Applications/OpenMausBot.app && cp -R release/mac-arm64/OpenMausBot.app /Applications/
env -u ELECTRON_RUN_AS_NODE open -a /Applications/OpenMausBot.app
git checkout electron/vendor/electron-updater.cjs   # packaging rewrites it
```

### What to exercise at each gate

| Round | What Omkar should see |
|---|---|
| 1 | A `computer_exec` or `ask_bot` call with a huge result comes back short, with a truncation note (and a readable `.maus/tool-output/*.txt` path when the bot has a private workspace). Sending a bot to a Cloudflare-protected page makes it stop and ask for takeover instead of retrying, and fires one takeover notification, not a stream of them. The inspector's Activity list fills in as a bot works, and shows no secrets. |
| 2 | A routine fires from a GitHub webhook, not just a clock. A bot that has already finished a turn wakes itself up when the event lands. Connector-resume still behaves exactly as it does today (this is the regression to watch — it is a refactor of working code). An executor runs a task in the background while the parent bot stays free to talk, and reports back when it finishes. |
| 3 | With auto-review in `shadow`, cards still appear as they do now and the decision log fills with what it *would* have done — compare that against what you actually clicked before turning `enforce` on. With synthesis on, MEMORY.md gains a `<!-- maus:synthesized -->` block, and anything you wrote by hand above or below it is untouched after several turns. |

---

## Verified findings — what the repo already has

Checked against the tree on 2026-08-24. Three of the eight items are much
smaller than they look, and one is architecturally different from the
reference implementation.

| # | Assumed gap | Repo actually has | Effect on scope |
|---|---|---|---|
| 1 | "Bots have no memory" | **Full per-bot memory already ships.** `server/workspace.ts` gives every bot `~/.openmausbot/workspaces/<botId>/MEMORY.md` plus a `memory/` topic dir, budgeted at 200 lines / 24 KB, injected into the system prompt by `memorySystemPrompt(botId)` at `server/index.ts:1684` and `:1940`. The bot curates it with its own file tools. | Item 3.2 is **memory *synthesis* only** — a host-driven writer for facts the agent didn't think to record. The storage, budget, prompt, and UI already exist. |
| 2 | "No wake mechanism" | **`dispatchConnectorResume` / `pendingConnectorResumes` / `drainConnectorResumes` (`server/index.ts:2145–2200`) is already a wake queue** — it re-enters a settled bot with a synthetic prompt, defers while `bot.busy`, and handles the group case. It is just hardcoded to one trigger. `delegations.ts` independently drains on `turn.completed`. | Item 2.1 is a **generalisation refactor** of code that already works, not a new subsystem. Two existing callers must come out behaviourally identical. |
| 3 | "Tool output is unbounded" | For CLI drivers (claude, codex, ACP) tools run **inside the CLI** — the harness never sees the result text, only `item.completed` events. | Item 1.1 applies **only to harness-owned MCP servers**: `computer-proxy.ts`, `drivers/agents-proxy.ts`, `drivers/phone-proxy.ts`. That is where the real bloat is anyway (semantic snapshots, `computer_exec` stdout, `ask_bot` replies). |
| 4 | "Auto-approve is all we have" | `autoVerdict()` already returns `{approve, source, rule}` with provenance, and `decision-log.ts` already writes a fleet-wide NDJSON authorization log. | Item 3.1 is **one more verdict source**, consulted only where `autoVerdict` returns `no-grant`. Shadow mode needs no new logging substrate. |
| 5 | `generateText` is available for classifier work | Declared on `ProviderInstance` (`contracts.ts:339`) and implemented by **claude, antigravity, minimax, grok, openai-compat** — but **not** codex or any ACP driver, and **nothing in the server calls it today**. | Items 3.1 and 3.2 must resolve a *helper instance*: the bot's own instance if it supports `generateText`, else any enabled instance that does, else the feature is silently off for that bot. This is a shared dependency — build it once (Task 7). |
| 6 | Routines can react to app events | `RoutineSchedule` is `once \| daily` only; `webhooks.ts` accepts generic signed payloads with an event-name allowlist, and Composio is wired for **tools, not triggers** — there is no event stream from it. | Item 2.2 builds typed listeners on top of the **existing webhook ingress**. No new OAuth, no Composio trigger API. |

---

## Rounds

Order is execution order. Round 1 items are independent of each other and of
everything after; Round 2 builds the wake substrate and the two features that
ride on it; Round 3 adds the two judgement layers, which are the only items
that call a model and therefore the only ones that can be wrong in a way a
user notices.

**Round 1 is fully broken down into TDD tasks below and is what executes
now.** Rounds 2 and 3 carry design, file lists, and acceptance criteria here,
and each gets its own dated plan document (same shape as Tasks 1–3) written
when its round starts — writing their steps today would pin interfaces against
a tree three merges out of date. Round 2 additionally depends on a finding
from Round 1 (see Risk 1), which is another reason not to freeze it yet.

### Round 1 — bounding, detecting, recording

Three self-contained additions. None changes a decision, so none needs a
setting. Ship them in one branch each; each is independently releasable.

**1.1 Bounded tool output with workspace spill** — `server/tool-output.ts`.
A pure `boundToolText(text, opts)` that returns the text unchanged under
threshold, and otherwise a head slice plus a pointer line. When the bot has a
private workspace (`privateWorkspace` is on) the elided remainder is written
to `<workspace>/.maus/tool-output/<uuid>.txt` and the pointer names the path,
because the bot's own file tools can read it. When it does not, the pointer
says how many bytes were dropped and to re-run narrowed. Wired into the three
harness-owned MCP result builders (`computer-proxy.ts:415`,
`agents-proxy.ts:69`, `phone-proxy.ts:245`). Full TDD breakdown in **Task 1**.

**1.2 Bot-block detection** — `server/bot-block.ts`. A signature table over
`{url, title}` recognising the challenge and denial pages a browsing agent
gets stuck on (Cloudflare interstitials, reCAPTCHA/hCaptcha/Arkose frames,
DataDome, PerimeterX, Imperva, AWS WAF, Vercel checkpoint, Google `/sorry`,
LinkedIn checkpoint, generic "Access Denied" titles), each tagged
`high` or `low` confidence. Wired into `computer-proxy.ts` at the two places
that already hold a verified URL and title — `browser_navigate` (`:912–923`)
and `open_url` (`:993–1014`) — plus the semantic snapshot path (`:884–888`).
A high-confidence hit turns the tool result into an explicit "you are blocked,
ask the user to take over" and emits the **existing** `takeover` notification
kind (`notify.ts:13`). Low confidence only records. Full TDD breakdown in
**Task 2**.

**1.3 Per-bot action ledger** — `server/action-audit.ts`. `decision-log.ts`
answers *"was it allowed"* fleet-wide; this answers *"what did this bot
actually do"* per bot. It is a **projection, not new capture**: the event bus
already tees every `RuntimeEvent` to `~/.openmausbot/events/<threadId>.ndjson`.
A bus subscriber folds tool activity into `~/.openmausbot/audit/<botId>.jsonl`
(one line per action: tool call, browser navigation, computer-use session with
action and screenshot counts, shell command), 0600, through `redactSecrets`,
bounded by size with rotation. Exposed at `GET /api/bots/:id/audit?limit=`
and rendered as an Activity list in `src/components/InspectorPanel.tsx`.
Full TDD breakdown in **Task 3**.

### Round 2 — the wake substrate and what rides on it

**2.1 General wake queue** — `server/wakes.ts`. Lift the connector-resume
machinery into a typed queue: `enqueueWake({botId, threadId, prompt, source,
key})`, deduped by `key`, deferred while `store.bot(botId).busy`, drained from
the same two points that drain today (the `turn.completed` fold and the
idle sweep), with the group path preserved verbatim. `WakeSource` starts as
`"connector" | "listener" | "executor"`. **Acceptance is behavioural
equivalence:** `server/index.test.ts` and the connector-resume tests pass
unchanged, with `dispatchConnectorResume` reduced to a wake producer.

**2.2 Event-listener triggers** — `server/triggers.ts` + changes to
`routines.ts`, `webhooks.ts`, `webhook-ingress.ts`, `RoutinesPage.tsx`.
Adds a `RoutineTrigger` union alongside the existing schedule:
`{type:"github", repo, events[], userAllowlist?}`,
`{type:"slack", channel, match}`, `{type:"generic", eventName}`. Inbound
webhook payloads are normalised to a flat event record
(`{source, kind, repo, actor, title, …}`), matched against enabled routines,
and turned into a wake. The event body is injected inside the same
UNTRUSTED-DATA framing `webhooks.ts:320` already uses — a listener event is
third-party text and must never read as instruction. Matching is pure and
table-tested; the ingress change is thin.

**2.3 Executor subagents** — `server/executors.ts` + two tools on
`agents-proxy.ts`. An executor is a **hidden clone of the parent bot**
(`BotRecord.hidden` already exists, `store.ts:303`) running one task on its own
thread, so it needs no new concurrency model — the parent stays free to talk
while it works. `run_executor(task, success_criteria)` dispatches;
`message_executor(id, text)` steers a running one. On the executor's
`turn.completed` the result is enqueued as a wake to the parent. Caps: 3 live
executors per bot, one task each (a follow-up steers, it does not spawn a
duplicate), depth-capped exactly like `delegate_bot` so an executor can never
spawn an executor. Visibility reuses `comms-visibility.ts`.

### Round 3 — the judgement layers

Both items call a model, so both share Task 7's helper-instance resolver, both
fail closed, and both default off.

**3.1 Auto-review** — `server/auto-review.ts`. A per-bot mode
`autoReview: "off" | "shadow" | "enforce"` (default `off`). Consulted from the
fold at `index.ts:809` **only** when `autoVerdict` returned
`{approve: null, source: "no-grant"}` — it can never override the destructive
guard, the sensitive guard, the unattended block, or the local-computer block,
because those are the rules that exist precisely to outrank grants. The
classifier gets the tool, the summary, and the bot's persona, and returns
`{verdict, reason, proposedRule?}` under an 8-second timeout; a timeout, a
parse failure, or no helper instance all mean *card it*. In `shadow` the card
always shows and the would-be verdict is written to the decision log with
source `auto-review-shadow`, so the mode can be measured before it is trusted.

**3.2 Memory synthesis** — `server/memory-synthesis.ts`. Per-bot
`memorySynthesis: boolean` (default off). Debounced 15s after
`turn.completed`, it takes the settled user/assistant pairs since the last
sweep as evidence and asks for a bounded JSON change set
(`create` / `update` / `remove`). Two hard safety rules: changes are applied
**only inside a `<!-- maus:synthesized -->` … `<!-- /maus:synthesized -->`
block** in MEMORY.md, so anything the user or the bot wrote by hand can never
be clobbered; and turns whose origin is a webhook, a listener, an automation,
or another bot are **excluded from evidence** — the existing memory prompt
already promises the user that only verified first-hand facts get recorded
(`workspace.ts:165`), and synthesis must keep that promise. A sweep that
would push the file past `MEMORY_MAX_BYTES` is rejected whole.

---

## Task 1: Bounded tool output with workspace spill

**Files:**
- Create: `server/tool-output.ts`
- Create: `server/tool-output.test.ts`
- Modify: `server/computer-proxy.ts:415-416` (the `text()` result builder)
- Modify: `server/drivers/agents-proxy.ts:69-70` (`textResult`)
- Modify: `server/drivers/phone-proxy.ts:245` (`textResult`)

**Interfaces:**
- Consumes: `workspaceDir(botId)` from `server/workspace.ts`.
- Produces:
  - `SPILL_THRESHOLD_BYTES = 20_000`, `SPILL_HEAD_BYTES = 2_000`, `MAX_SPILL_FILE_BYTES = 1_000_000`
  - `boundToolText(text: string, opts?: { botId?: string; label?: string }): string`
  - `spillPath(botId: string, id: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// server/tool-output.test.ts
import { describe, expect, it } from "vitest";

import { SPILL_HEAD_BYTES, SPILL_THRESHOLD_BYTES, boundToolText } from "./tool-output.ts";

describe("boundToolText", () => {
  it("returns short output untouched", () => {
    expect(boundToolText("all good")).toBe("all good");
  });

  it("keeps a head slice and says how much was dropped when there is no workspace", () => {
    const big = "x".repeat(SPILL_THRESHOLD_BYTES + 5_000);
    const bounded = boundToolText(big);
    expect(bounded.length).toBeLessThan(SPILL_HEAD_BYTES + 500);
    expect(bounded.startsWith("x".repeat(100))).toBe(true);
    expect(bounded).toContain("truncated");
    expect(bounded).toContain(String(big.length));
    expect(bounded).not.toContain(".txt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/tool-output.test.ts`
Expected: FAIL — `Failed to resolve import "./tool-output.ts"`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// server/tool-output.ts
// Bounding what a harness-owned MCP server hands back to an agent.
//
// CLI drivers run their own tools, so the harness never sees that output —
// this only covers the servers WE own (computer-proxy, agents-proxy,
// phone-proxy), which is where the bloat actually is: semantic snapshots,
// computer_exec stdout, ask_bot replies.
//
// A bot with a private workspace can read a spilled file with its ordinary
// file tools, so the remainder is written there and named. A bot without one
// only gets told what was dropped — still the whole point, which is that a
// 400 KB tool result must not eat the context window.
export const SPILL_THRESHOLD_BYTES = 20_000;
export const SPILL_HEAD_BYTES = 2_000;
export const MAX_SPILL_FILE_BYTES = 1_000_000;

function headSlice(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= SPILL_HEAD_BYTES) return text;
  return buf.subarray(0, SPILL_HEAD_BYTES).toString("utf8").replace(/�+$/, "");
}

export function boundToolText(text: string): string {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= SPILL_THRESHOLD_BYTES) return text;
  const head = headSlice(text);
  return `${head}\n\n[Output truncated: ${total} bytes total, first ${Buffer.byteLength(head, "utf8")} shown. Re-run narrowed (grep/head/a tighter selector) if you need the rest.]`;
}

// Step 8 widens this signature to take `opts`; keep it narrow until the
// spill test forces it, so nothing is written that no test asked for.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/tool-output.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/tool-output.ts server/tool-output.test.ts
git commit -m "feat(server): bound oversized harness-owned MCP tool output"
```

- [ ] **Step 6: Write the failing spill test**

```ts
// append to server/tool-output.test.ts
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_SPILL_FILE_BYTES } from "./tool-output.ts";

describe("boundToolText with a workspace", () => {
  it("writes the full text to the bot workspace and names the path", () => {
    const root = mkdtempSync(join(tmpdir(), "maus-spill-"));
    process.env.OPENMAUSBOT_DATA_DIR = root;
    const big = "y".repeat(SPILL_THRESHOLD_BYTES + 5_000);
    const bounded = boundToolText(big, { botId: "bot-1", label: "computer_exec" });
    const dir = join(root, "workspaces", "bot-1", ".maus", "tool-output");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0]!), "utf8")).toBe(big);
    expect(bounded).toContain(files[0]!);
    expect(bounded).toContain("computer_exec");
  });

  it("caps what it writes to disk", () => {
    const root = mkdtempSync(join(tmpdir(), "maus-spill-"));
    process.env.OPENMAUSBOT_DATA_DIR = root;
    const huge = "z".repeat(MAX_SPILL_FILE_BYTES + 10_000);
    boundToolText(huge, { botId: "bot-2" });
    const dir = join(root, "workspaces", "bot-2", ".maus", "tool-output");
    const written = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(Buffer.byteLength(written, "utf8")).toBe(MAX_SPILL_FILE_BYTES);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm vitest run server/tool-output.test.ts`
Expected: FAIL — the spill directory does not exist.

- [ ] **Step 8: Implement the spill branch**

```ts
// server/tool-output.ts — add these imports and replace boundToolText
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { workspaceDir } from "./workspace.ts";

export function spillPath(botId: string, id: string): string {
  return join(workspaceDir(botId), ".maus", "tool-output", `${id}.txt`);
}

function spill(botId: string, text: string): string | null {
  try {
    const id = randomUUID();
    const path = spillPath(botId, id);
    mkdirSync(join(workspaceDir(botId), ".maus", "tool-output"), { recursive: true, mode: 0o700 });
    const buf = Buffer.from(text, "utf8");
    const capped = buf.byteLength > MAX_SPILL_FILE_BYTES ? buf.subarray(0, MAX_SPILL_FILE_BYTES) : buf;
    writeFileSync(path, capped, { mode: 0o600 });
    return path;
  } catch {
    // a failed spill must never fail the tool call — fall back to the note
    return null;
  }
}

export function boundToolText(text: string, opts?: { botId?: string; label?: string }): string {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= SPILL_THRESHOLD_BYTES) return text;
  const head = headSlice(text);
  const shown = Buffer.byteLength(head, "utf8");
  const path = opts?.botId ? spill(opts.botId, text) : null;
  const what = opts?.label ? `${opts.label} output` : "Output";
  if (path) {
    return `${head}\n\n[${what} truncated: ${total} bytes total, first ${shown} shown. The full output is on disk at ${path} — read it with your file tools, or narrow the command instead.]`;
  }
  return `${head}\n\n[${what} truncated: ${total} bytes total, first ${shown} shown. Re-run narrowed (grep/head/a tighter selector) if you need the rest.]`;
}
```

- [ ] **Step 9: Run the tests**

Run: `pnpm vitest run server/tool-output.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 10: Commit**

```bash
git add server/tool-output.ts server/tool-output.test.ts
git commit -m "feat(server): spill oversized tool output into the bot workspace"
```

- [ ] **Step 11: Wire the three call sites**

In `server/computer-proxy.ts`, change the `text()` helper (`:415`) to pass its
string through `boundToolText(t, { botId, label: toolName })`. The proxy
already knows which bot it serves — thread it in from the same place the
control-client token comes from; if no botId is in scope, call with `{}` and
take the truncation-only path. Repeat for `agents-proxy.ts:69` (label
`"ask_bot"`) and `phone-proxy.ts:245` (label the tool name). Do **not** bound
image content items — only `type: "text"`.

- [ ] **Step 12: Verify nothing regressed**

Run: `pnpm vitest run server/computer-proxy.test.ts server/drivers` and `pnpm typecheck`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add server/computer-proxy.ts server/drivers/agents-proxy.ts server/drivers/phone-proxy.ts
git commit -m "feat(server): bound tool output at the harness-owned MCP servers"
```

---

## Task 2: Bot-block detection

**Files:**
- Create: `server/bot-block.ts`
- Create: `server/bot-block.test.ts`
- Modify: `server/computer-proxy.ts` (`browser_navigate` `:912-923`, `open_url` `:993-1014`, snapshot `:884-888`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `type BlockHit = { family: string; confidence: "high" | "low"; host: string }`
  - `classifyBlockPage(page: { url: string; title?: string }): BlockHit | undefined`
  - `blockedToolNote(hit: BlockHit): string`

- [ ] **Step 1: Write the failing test**

```ts
// server/bot-block.test.ts
// The pages a browsing agent gets stuck on. Getting this wrong in the
// permissive direction wastes a turn; getting it wrong in the strict
// direction interrupts the user over an ordinary page — so anything that
// could be a real page title is "low" and only records.
import { describe, expect, it } from "vitest";

import { classifyBlockPage } from "./bot-block.ts";

describe("classifyBlockPage", () => {
  const blocked: Array<[string, string, string]> = [
    ["https://www.google.com/sorry/index?continue=x", "", "google_sorry"],
    ["https://challenges.cloudflare.com/turnstile", "", "cloudflare_challenge"],
    ["https://shop.example.com/", "Just a moment...", "cloudflare_challenge"],
    ["https://geo.captcha-delivery.com/captcha/", "", "datadome"],
    ["https://example.com/px/captcha", "", "perimeterx"],
    ["https://example.com/_Incapsula_Resource?SWUDNSAI=9", "", "imperva"],
    ["https://abc.token.awswaf.com/abc", "", "aws_waf"],
    ["https://www.linkedin.com/checkpoint/challenge/verify", "", "linkedin_checkpoint"],
    ["https://app.example.com/", "Vercel Security Checkpoint", "vercel_checkpoint"],
  ];
  for (const [url, title, family] of blocked) {
    it(`flags ${family} for ${url || title}`, () => {
      const hit = classifyBlockPage({ url, title });
      expect(hit?.family).toBe(family);
      expect(hit?.confidence).toBe("high");
    });
  }

  it("does not flag an ordinary page", () => {
    expect(classifyBlockPage({ url: "https://example.com/docs", title: "Docs" })).toBeUndefined();
  });

  it("does not flag a page that merely mentions captcha in its path", () => {
    expect(classifyBlockPage({ url: "https://example.com/blog/how-captcha-works", title: "How CAPTCHA works" })).toBeUndefined();
  });

  it("returns undefined for an unparseable url", () => {
    expect(classifyBlockPage({ url: "not a url", title: "" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/bot-block.test.ts`
Expected: FAIL — `Failed to resolve import "./bot-block.ts"`.

- [ ] **Step 3: Write the implementation**

```ts
// server/bot-block.ts
// Recognising the page that means "you are not getting through this one".
//
// A browsing agent that lands on a Cloudflare interstitial or a reCAPTCHA
// frame does not know it is stuck: it screenshots, sees a page, tries again,
// and burns the turn. The harness can tell, cheaply, from the URL and title
// the browser tools already return — so it tells the agent to stop and hand
// the wheel to the user, which is what the system prompt already asks for at
// a CAPTCHA step.
//
// `high` changes the tool result and notifies. `low` only records: a page
// titled "Access Denied" is usually a block and occasionally a real 403 page
// someone meant to visit, and interrupting a person over that is worse than
// missing it.
type Match = { equals?: string[]; suffix?: string[]; prefix?: string[]; includes?: string[]; startsWith?: string[] };

export interface BlockSignature {
  family: string;
  confidence: "high" | "low";
  host?: Match;
  path?: Match;
  title?: Match;
}

export const BLOCK_SIGNATURES: BlockSignature[] = [
  { family: "google_sorry", confidence: "high", host: { equals: ["google.com"], suffix: [".google.com"] }, path: { prefix: ["/sorry"] } },
  { family: "google_signin_rejected", confidence: "high", host: { equals: ["accounts.google.com"] }, path: { includes: ["/signin/rejected"] } },
  { family: "cloudflare_challenge", confidence: "high", host: { equals: ["challenges.cloudflare.com"] } },
  { family: "cloudflare_challenge", confidence: "high", path: { includes: ["/cdn-cgi/challenge-platform/"] } },
  { family: "cloudflare_challenge", confidence: "high", title: { startsWith: ["Just a moment", "Attention Required! | Cloudflare"] } },
  { family: "recaptcha", confidence: "low", path: { includes: ["/recaptcha/api2/", "/recaptcha/enterprise/"] } },
  { family: "hcaptcha", confidence: "low", host: { equals: ["hcaptcha.com"], suffix: [".hcaptcha.com"] } },
  { family: "arkose", confidence: "high", host: { suffix: [".arkoselabs.com", ".funcaptcha.com"] } },
  { family: "datadome", confidence: "high", host: { equals: ["captcha-delivery.com", "captcha.datadome.co"], suffix: [".captcha-delivery.com"] } },
  { family: "perimeterx", confidence: "high", path: { includes: ["/px/captcha"] } },
  { family: "perimeterx", confidence: "high", host: { suffix: [".px-cloud.net"] } },
  { family: "imperva", confidence: "high", path: { includes: ["/_Incapsula_Resource"] } },
  { family: "aws_waf", confidence: "high", host: { suffix: [".token.awswaf.com"] } },
  { family: "linkedin_checkpoint", confidence: "high", host: { equals: ["linkedin.com"], suffix: [".linkedin.com"] }, path: { prefix: ["/checkpoint/challenge"] } },
  { family: "vercel_checkpoint", confidence: "high", title: { startsWith: ["Vercel Security Checkpoint"] } },
  { family: "distil", confidence: "high", title: { equals: ["Pardon Our Interruption"] } },
  { family: "generic_access_denied", confidence: "low", title: { equals: ["Access Denied", "Access to this page has been denied"] } },
];

export interface BlockHit {
  family: string;
  confidence: "high" | "low";
  host: string;
}

const hits = (m: Match | undefined, value: string): boolean => {
  if (!m) return true;
  return (
    (m.equals?.includes(value) ?? false) ||
    (m.suffix?.some((s) => value.endsWith(s)) ?? false) ||
    (m.prefix?.some((s) => value.startsWith(s)) ?? false) ||
    (m.includes?.some((s) => value.includes(s)) ?? false) ||
    (m.startsWith?.some((s) => value.startsWith(s)) ?? false)
  );
};

export function classifyBlockPage(page: { url: string; title?: string }): BlockHit | undefined {
  if (!URL.canParse(page.url)) return undefined;
  const parsed = new URL(page.url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const title = (page.title ?? "").trim();
  for (const sig of BLOCK_SIGNATURES) {
    // an all-undefined signature would match everything — never allow one
    if (!sig.host && !sig.path && !sig.title) continue;
    if (hits(sig.host, host) && hits(sig.path, parsed.pathname) && hits(sig.title, title)) {
      return { family: sig.family, confidence: sig.confidence, host };
    }
  }
  return undefined;
}

export function blockedToolNote(hit: BlockHit): string {
  return `This page is an anti-bot challenge (${hit.family} on ${hit.host}), not the content you asked for. Do not retry it and do not try to solve it. Stop here and ask the user to open the computer and get past it themselves, then continue once they say it is done.`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run server/bot-block.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add server/bot-block.ts server/bot-block.test.ts
git commit -m "feat(server): recognise anti-bot challenge pages"
```

- [ ] **Step 6: Write the failing wiring test**

Add to `server/computer-proxy.test.ts`, following the existing harness in that
file for driving a tool call and reading the JSON-RPC result:

```ts
it("tells the agent to hand over when navigation lands on a challenge page", async () => {
  const result = await callTool("open_url", { url: "https://challenges.cloudflare.com/turnstile" });
  const text = result.content.map((c: { text?: string }) => c.text ?? "").join("\n");
  expect(text).toContain("anti-bot challenge");
  expect(text).toContain("ask the user");
  expect(result.isError).toBe(true);
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm vitest run server/computer-proxy.test.ts`
Expected: FAIL — the result reports ordinary navigation.

- [ ] **Step 8: Wire the three navigation sites**

At `browser_navigate` (`:912-923`) and `open_url` (`:993-1014`), after the
existing verification step, run `classifyBlockPage` over each verified target's
`{url, title}`. On a `high` hit, replace the result text with
`blockedToolNote(hit)` and set `isError`; on `low`, leave the result alone.
At the snapshot path (`:884-888`), classify `snapshot.url` with the page title
and append the note rather than replacing the snapshot — a snapshot still
carries useful state.

- [ ] **Step 9: Run the tests**

Run: `pnpm vitest run server/computer-proxy.test.ts`
Expected: PASS.

- [ ] **Step 10: Emit the takeover notification**

In `server/index.ts`, where computer-proxy events are already folded, a high
hit emits the existing `takeover` notification kind
(`{kind: "takeover", botId, botName, threadId, title: "<bot> is blocked", body: "<host> is showing an anti-bot challenge"}`)
through the same notify path approvals use. Rate-limit to one per
`threadId:host` per 10 minutes so a retry loop cannot spam the user.

- [ ] **Step 11: Verify and commit**

```bash
pnpm vitest run server/computer-proxy.test.ts server/index.test.ts && pnpm typecheck
git add server/computer-proxy.ts server/index.ts server/computer-proxy.test.ts
git commit -m "feat(server): stop and ask for takeover on anti-bot challenge pages"
```

---

## Task 3: Per-bot action ledger

**Files:**
- Create: `server/action-audit.ts`
- Create: `server/action-audit.test.ts`
- Modify: `server/index.ts` (one bus subscriber, one route)
- Modify: `src/components/InspectorPanel.tsx` (Activity list)

**Interfaces:**
- Consumes: `RuntimeEvent` from `server/contracts.ts`; `redactSecrets` from `server/redact.ts`.
- Produces:
  - `type ActionRow = { ts: string; botId: string; threadId: string; turnId?: string; type: "tool_call" | "browser_navigation" | "computer_session"; name: string; ok?: boolean; detail?: string }`
  - `appendAction(dataDir: string, row: Omit<ActionRow, "ts">): void`
  - `readActions(dataDir: string, botId: string, limit: number): ActionRow[]`
  - `actionFromEvent(event: RuntimeEvent, botId: string): Omit<ActionRow, "ts"> | null`

- [ ] **Step 1: Write the failing test for the projection**

```ts
// server/action-audit.test.ts
import { describe, expect, it } from "vitest";

import { actionFromEvent } from "./action-audit.ts";

const base = { eventId: "e1", provider: "claude", threadId: "t1", createdAt: "2026-08-24T00:00:00Z", turnId: "turn-1" };

describe("actionFromEvent", () => {
  it("records a completed tool call", () => {
    const started = actionFromEvent({ ...base, type: "item.started", itemType: "tool", title: "Bash(git status)", itemId: "i1" } as never, "bot-1");
    expect(started).toEqual({ botId: "bot-1", threadId: "t1", turnId: "turn-1", type: "tool_call", name: "Bash(git status)" });
  });

  it("ignores reasoning items", () => {
    expect(actionFromEvent({ ...base, type: "item.started", itemType: "reasoning" } as never, "bot-1")).toBeNull();
  });

  it("ignores stream deltas", () => {
    expect(actionFromEvent({ ...base, type: "content.delta", streamKind: "assistant_text", delta: "hi" } as never, "bot-1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run server/action-audit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the projection and the writer**

```ts
// server/action-audit.ts
// What a bot actually DID, per bot.
//
// decision-log.ts answers "was this allowed, by which rule" fleet-wide.
// That is the authorization record and it stays exactly as it is. This is
// the activity record: one append-only NDJSON file per bot, folded out of
// the event stream the bus already tees, so nothing new is captured — it is
// only projected somewhere a person can read it per bot instead of per
// thread.
//
// Same discipline as the decision log: 0600 (rows name tools and command
// lines), through redactSecrets, and fire-and-forget — an activity log must
// never take down the turn it is recording.
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeEvent } from "./contracts.ts";
import { redactSecrets } from "./redact.ts";

export const MAX_AUDIT_BYTES = 4_000_000;

export interface ActionRow {
  ts: string;
  botId: string;
  threadId: string;
  turnId?: string;
  type: "tool_call" | "browser_navigation" | "computer_session";
  name: string;
  ok?: boolean;
  detail?: string;
}

export function auditPath(dataDir: string, botId: string): string {
  return join(dataDir, "audit", `${botId}.jsonl`);
}

export function actionFromEvent(event: RuntimeEvent, botId: string): Omit<ActionRow, "ts"> | null {
  if (event.type !== "item.started" || event.itemType !== "tool") return null;
  const name = event.title?.trim();
  if (!name) return null;
  return {
    botId,
    threadId: event.threadId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    type: "tool_call",
    name,
  };
}

export function appendAction(dataDir: string, row: Omit<ActionRow, "ts">): void {
  const line = `${JSON.stringify(redactSecrets({ ts: new Date().toISOString(), ...row }))}\n`;
  const path = auditPath(dataDir, row.botId);
  void (async () => {
    try {
      await mkdir(join(dataDir, "audit"), { recursive: true, mode: 0o700 });
      const size = await stat(path).then((s) => s.size).catch(() => 0);
      if (size > MAX_AUDIT_BYTES) await rename(path, `${path}.1`).catch(() => {});
      await appendFile(path, line, { mode: 0o600 });
    } catch {
      /* an activity log must never take down a turn */
    }
  })();
}

export function readActions(dataDir: string, botId: string, limit: number): ActionRow[] {
  let raw: string;
  try {
    raw = readFileSync(auditPath(dataDir, botId), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  const rows: ActionRow[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      rows.push(JSON.parse(line) as ActionRow);
    } catch {
      /* a torn final line is not a reason to lose the rest */
    }
  }
  return rows.reverse();
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run server/action-audit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing round-trip test**

```ts
// append to server/action-audit.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAction, readActions } from "./action-audit.ts";

it("round-trips rows newest first and redacts secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maus-audit-"));
  appendAction(dir, { botId: "bot-1", threadId: "t1", type: "tool_call", name: "Bash(export TOKEN=sk-live-abcdefghijklmnop)" });
  appendAction(dir, { botId: "bot-1", threadId: "t1", type: "tool_call", name: "Bash(git status)" });
  await new Promise((r) => setTimeout(r, 50));
  const rows = readActions(dir, "bot-1", 10);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.name).toBe("Bash(git status)");
  expect(rows[1]!.name).not.toContain("sk-live-abcdefghijklmnop");
});
```

- [ ] **Step 6: Run it**

Run: `pnpm vitest run server/action-audit.test.ts`
Expected: PASS (4 tests). If the redaction assertion fails, the token shape is
not one `redactSecrets` knows — check `server/redact.ts` and use a shape it
covers rather than weakening the assertion.

- [ ] **Step 7: Commit**

```bash
git add server/action-audit.ts server/action-audit.test.ts
git commit -m "feat(server): per-bot action ledger"
```

- [ ] **Step 8: Wire the bus subscriber and the route**

In `server/index.ts`, inside the existing bus subscriber (`:727`), after `bot`
is resolved and before the switch, call:

```ts
const action = bot ? actionFromEvent(event, bot.id) : null;
if (action) appendAction(DATA_DIR, action);
```

Then add the route beside the other `/api/bots/:id/*` handlers:

```ts
if (method === "GET" && /^\/api\/bots\/[^/]+\/audit$/.test(path)) {
  const botId = path.split("/")[3]!;
  const limit = pageSize(url.searchParams.get("limit"));
  return json(res, 200, { actions: readActions(DATA_DIR, botId, limit) });
}
```

- [ ] **Step 9: Verify the server still passes**

Run: `pnpm vitest run server/index.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Add the Activity list**

In `src/components/InspectorPanel.tsx`, add an "Activity" section that fetches
`/api/bots/<id>/audit?limit=50` when the panel opens and renders each row as
`<time> · <name>`, newest first, with an empty state of "No recorded activity
yet." Follow the panel's existing fetch-and-render pattern; no polling.

- [ ] **Step 11: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm vitest run server/index.test.ts
git add server/index.ts src/components/InspectorPanel.tsx
git commit -m "feat: show a bot's recorded activity in the inspector"
```

- [ ] **Step 12: Round 1 gate — build, hand over, stop**

Round 1 is complete. Run the dev-app recipe from the working agreement above,
tell Omkar the branch name and the Round 1 row of the what-to-exercise table,
and **stop**. Do not push. Do not open a PR. Do not start Round 2.

---

## Deferred — the bigger bets

Out of scope for this plan; listed so they are not re-discovered as new ideas.

- **Secure secret request (issue #255).** The agent asks for a credential by
  label; the *host* collects it and writes it straight to its destination; the
  agent gets back only an acknowledgement and never sees the value. This is
  the bot-invisible broker the blind-fill design was rejected in favour of,
  and it is smaller than most items in Round 3 — worth pulling forward the
  moment this plan's Round 1 lands.
- **Cross-user sharing.** Sharing a room with another human: remote turn
  relay, departure obligations, room tombstones, turn dedupe. Real multiplayer,
  and the largest single piece of work in the reference implementation.
- **Hardened content search index.** A worker-thread SQLite FTS index with
  schema versioning, corruption rebuild caps, and media search, replacing
  today's `searchMessages`.
- **Harness-only upgrade channel.** Ship server fixes without a full app
  update, separate from `electron-updater`.

---

## Risks and open questions

1. **`computer-proxy.ts` does not obviously know its `botId`.** Tasks 1 and 2
   both want it. Confirm before starting Task 1: if it is not in scope, thread
   it in from the same place the control-client token is resolved, and if that
   turns out to be invasive, Task 1 ships truncation-only (still the point) and
   Task 2 emits its notification from `index.ts` instead of the proxy.
2. **Auto-review adds latency to a blocked turn.** Up to 8 seconds before a
   card appears, on a bot that is already waiting. Mitigated by an activity
   chip while the review runs, and by the mode defaulting off. If shadow-mode
   data shows it rarely changes the outcome, drop `enforce` rather than keeping
   a slow path nobody benefits from.
3. **Memory synthesis writes to a file the user owns.** The fenced-block rule
   is the whole safety story; it must be tested against a MEMORY.md that has
   been hand-edited, a file with no fence, a file with two fences, and a file
   where the fence markers appear inside a code block.
4. **`generateText` coverage is partial.** Codex and every ACP driver lack it.
   A user whose only engine is codex gets neither Round 3 feature and must be
   told so in settings copy rather than silently getting nothing.
5. **Executors multiply cost.** Three background clones per bot is three times
   the token burn with no extra confirmation step. The cap is the control;
   revisit it against real usage before raising it.
