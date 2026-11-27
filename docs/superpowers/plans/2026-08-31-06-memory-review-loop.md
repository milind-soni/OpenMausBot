# Memory Review Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn memory from a file the bot silently overwrites into a reviewed change: the bot proposes a typed diff, the person sees what changed and why, and approve/reject/edit is one click — with every accepted change recorded in the profile version log and reversible.

**Architecture:** The bot stops writing `MEMORY.md` directly and instead calls a `propose_memory` tool on the existing agents MCP proxy. The proposal becomes a card in the transcript using the same mechanism `server/peer-approval.ts` already uses — appending straight to the store rather than crossing the runtime bus. An accepted proposal is applied by `writeMemoryFile` and appended to the P2 version log, which is what makes rollback free.

**Tech Stack:** TypeScript, Node 24, Vitest, React.

**Spec:** none — this plan is its own spec.

## Global Constraints

See [the roadmap](2026-08-31-00-control-plane-roadmap.md#global-constraints). Load-bearing:

- **Persisted files are `0600` and redacted.** A memory proposal is agent-authored text and must pass `redactSecrets` before it reaches disk — a bot that reads a `.env` and helpfully "remembers" it is the exact failure this prevents.
- **Audit what you authorize.** An approved memory write is an authorization decision; it gets a version row.

**Depends on:** [P2](2026-08-31-02-bot-profile.md) — proposals record into `appendProfileVersion`.

---

## Background

`server/workspace.ts` gives every bot a `MEMORY.md` and a `memory/` directory, budgeted
into the system prompt at 200 lines / 24_000 bytes and readable by the agent's own file
tools. It is genuinely engine-independent — the community's "learning survives an engine
switch" ask is already satisfied.

What is missing is the review half. Today a bot edits `MEMORY.md` with an ordinary file
write. There is no diff, no approval, no typing, no history, and no way back. A bot that
writes down something wrong on Tuesday is still acting on it in March.

---

## File map

- Create `server/memory-proposals.ts`: the proposal store, diff computation, and apply/reject.
- Create `server/memory-proposals.test.ts`.
- Modify `server/workspace.ts`: typed entry parsing and a structured write path.
- Modify `server/workspace.test.ts`.
- Modify `server/drivers/agents-proxy.ts`: the `propose_memory` tool.
- Modify `server/drivers/agents-proxy.test.ts`.
- Modify `server/index.ts`: proposal endpoints and card wiring.
- Create `src/components/MemoryProposalCard.tsx`, `src/components/MemoryProposalCard.test.ts`.
- Modify `src/components/ChatView.tsx`: render the card.

---

### Task 1: Typed memory entries

**Files:**
- Modify: `server/workspace.ts`, `server/workspace.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MemoryKind = "fact" | "preference" | "decision" | "procedure";
  export interface MemoryEntry { kind: MemoryKind; text: string; at?: number }
  export function parseMemoryEntries(markdown: string): MemoryEntry[];
  export function renderMemoryEntries(entries: MemoryEntry[]): string;
  ```
  The on-disk form stays plain Markdown — `## Facts` / `## Preferences` / `## Decisions`
  / `## Procedures` with `- ` bullets. It must remain a file a person can open and edit
  by hand, and a file an agent's ordinary file tools can read. No JSON, no frontmatter.

- [ ] Write failing round-trip tests: `renderMemoryEntries(parseMemoryEntries(md))` is stable for a document with all four sections, and stable for a document with only one.
- [ ] Write a failing test that free-form Markdown with no recognized headings parses as a list of `fact` entries rather than throwing — every existing `MEMORY.md` in the wild predates this format and must keep working.
- [ ] Write a failing test that an unknown heading's content is preserved verbatim through a round trip. Losing a person's hand-written section because it did not match a heading is unacceptable.
- [ ] Run `pnpm vitest run server/workspace.test.ts`; expect FAIL.
- [ ] Implement. Leave `loadMemory`, `readMemoryFile`, `writeMemoryFile`, and `memorySystemPrompt` untouched — they operate on the raw text and must keep doing so.
- [ ] Run; expect PASS.
- [ ] Commit `feat(memory): typed entry parsing over the existing markdown`.

---

### Task 2: The proposal store

**Files:**
- Create: `server/memory-proposals.ts`, `server/memory-proposals.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MemoryProposal {
    id: string; botId: string; threadId: string; at: number;
    reason: string;
    add: MemoryEntry[]; remove: MemoryEntry[];
    status: "pending" | "accepted" | "rejected";
  }
  export function proposeMemory(input: { botId: string; threadId: string; reason: string; add: MemoryEntry[]; remove: MemoryEntry[] }): MemoryProposal | { error: string };
  export function listProposals(botId: string): MemoryProposal[];
  export function resolveProposal(id: string, verdict: "accept" | "reject", edited?: { add: MemoryEntry[]; remove: MemoryEntry[] }): { ok: true; applied: boolean } | { error: string };
  ```

- [ ] Write a failing test: proposing two additions and one removal stores a pending proposal; accepting it rewrites `MEMORY.md` so the additions are present and the removal is gone; the raw file still parses through `parseMemoryEntries`.
- [ ] Write a failing test that rejecting changes nothing on disk and marks the proposal `rejected` — a rejected proposal stays visible rather than vanishing, so the same suggestion arriving four times is legible as a pattern.
- [ ] Write a failing test for the edited path: accepting with an `edited` payload applies the person's version, not the bot's. This is the whole point — "approve, reject, **edit**" from the community list.
- [ ] Write a failing test that a proposal whose text contains a key-shaped value is redacted through `redactSecrets` **before** it is stored, so the secret never lands in the proposal file either. Assert on the stored proposal, not just on `MEMORY.md`.
- [ ] Write a failing test that a proposal exceeding `MEMORY_FILE_MAX_BYTES` when applied is refused at propose time with an actionable error, rather than accepted and silently truncated.
- [ ] Write a failing test that accepting appends exactly one `appendProfileVersion` row with `actor: "agent"` and `changed: ["memory"]`.
- [ ] Run; expect FAIL.
- [ ] Implement over `DATA_DIR/memory-proposals/<botId>.json`, written with `writeFileAtomic` at `0600`.
- [ ] Run; expect PASS.
- [ ] Commit `feat(memory): proposal store with accept, reject, and edit`.

---

### Task 3: The tool the bot calls

**Files:**
- Modify: `server/drivers/agents-proxy.ts`, `server/drivers/agents-proxy.test.ts`
- Modify: `server/index.ts` (`/api/internal/propose-memory`, beside the existing `/api/internal/*` block at `:2704`)
- Test: `server/index.test.ts`

- [ ] Write a failing test that the agents proxy advertises `propose_memory` with a schema taking `reason`, `add[]`, and `remove[]`, and that calling it reaches `/api/internal/propose-memory`.
- [ ] Write a failing test that the tool's result tells the model the proposal is **pending a person** and that it must not assume the memory is written. A tool that returns "ok" teaches the model to act on memory it does not have.
- [ ] Write a failing API test that `/api/internal/propose-memory` rejects a `botId` that does not match the calling bridge's bot — the internal routes are loopback but not unauthenticated by convention, and a bot proposing into a peer's memory is a real hazard.
- [ ] Run; expect FAIL.
- [ ] Implement. Extend the system-prompt guidance in `memorySystemPrompt` (`server/workspace.ts:155`) to tell the bot to propose rather than write directly when the tool is available, and to keep writing directly when it is not — engines without the agents MCP must not lose memory entirely.
- [ ] Run; expect PASS.
- [ ] Commit `feat(memory): propose_memory tool on the agents proxy`.

---

### Task 4: The card

**Files:**
- Create: `src/components/MemoryProposalCard.tsx`, `src/components/MemoryProposalCard.test.ts`
- Modify: `src/components/ChatView.tsx`
- Modify: `server/index.ts` (append the card to the thread on propose)

- [ ] Write a failing test for the pure diff renderer: additions render with a `+` and their kind label, removals with a `−`, and an entry that appears in both lists renders once as a **change** rather than twice. A rewritten line shown as an unrelated add and remove is unreadable.
- [ ] Run; expect FAIL.
- [ ] Implement the card: the reason the bot gave, the diff, and Approve / Edit / Reject. Edit opens the proposed text inline and Approve then applies the edited version.
- [ ] Append the card to the thread the same way `server/peer-approval.ts` does — straight to the store, not across the runtime bus. Its module comment explains why, and `server/decision-log.ts:19` records the consequence: cards appended this way do not reach the decision log. Accept that here too; the profile version log from Task 2 is this feature's audit trail.
- [ ] Add a Memory tab to the bot's settings showing current entries by kind and the proposal history, with restore wired to P2's rollback.
- [ ] Run the focused test, `pnpm typecheck`, `pnpm check:contrast`.
- [ ] Commit `feat(memory): review card with approve, edit, and reject`.

---

### Task 5: Sharing a skill across bots

**Files:**
- Modify: `server/skills.ts`, `server/skills.test.ts`
- Modify: `server/index.ts`

- [ ] Write a failing test that `copySkill(fromBotId, toBotId, name)` installs the skill on the target with its provenance (`source`, `sha256`) intact and **disabled**, matching the import policy.
- [ ] Write a failing test that copying to a bot that already has a skill of that name with a different hash is refused with both hashes named, rather than silently overwriting.
- [ ] Run; expect FAIL.
- [ ] Implement `copySkill` and a `POST /api/bots/:id/skills/copy-from` route. This is the community's "share selected skills across bots or entire teams" — deliberately scoped to skills, not memory. Memory is private per bot by design (`server/section-context.ts:3` draws the same line), and sharing it across bots is a different feature with a different consent story.
- [ ] Run; expect PASS.
- [ ] Commit `feat(skills): copy a skill to another bot, disabled with provenance intact`.

---

## Self-review

**Coverage of the community's memory list.** Search past sessions — already exists
(`/api/search`). Distinguish facts, preferences, decisions, procedures — Task 1. Propose
updates — Task 3. Show the diff and why — Task 4. Approve, reject, edit, version, roll
back — Tasks 2, 4 plus P2's log. Share skills across bots — Task 5. Preserve learning
across an engine switch — already true, and unchanged by this plan.

**Type consistency.** `MemoryKind`/`MemoryEntry` (Task 1) are used by Tasks 2, 3, 4.
`MemoryProposal` (Task 2) is what Task 3 creates and Task 4 renders.

**One honest limitation.** Task 4 appends its card outside the runtime bus, so a memory
approval does not appear in `decision-log.ts` alongside tool approvals. Two audit trails
for two kinds of decision is a real wart. Unifying them means giving `peer-approval.ts`
and this module a shared card path that tees into the decision log — worth doing, but it
is a refactor of a shipped approval path and belongs in its own change, not smuggled in
here.
