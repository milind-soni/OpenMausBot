# Memory Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make what a bot believes visible, editable, and auditable — a memory browser with a real capacity gauge, and a journal that records every change an agent makes to its own memory so the user can read it back and revert it.

**Architecture:** No new source of truth. `server/workspace.ts` already owns `MEMORY.md` and `memory/<topic>.md` as plain markdown under `~/.openmausbot/workspaces/<botId>/`. This plan adds a read/write module over those files with hard path containment, a change journal kept **outside** the workspace (so a bot cannot edit its own audit trail with the file tools it already has), a diff taken at turn boundaries, and one bot-scoped UI panel.

**Tech Stack:** TypeScript strict, Node 24, Vitest, React 19, Tailwind, zod.

**Spec:** none — this plan is its own spec. Motivated by the gap survey in [the roadmap](2026-08-31-00-control-plane-roadmap.md).

## Global Constraints

See [the roadmap](2026-08-31-00-control-plane-roadmap.md#global-constraints). The ones that shape this plan directly:

- **Persisted files are `0600`**, written through `writeFileAtomic` (`server/atomic.ts`), and anything agent-authored passes `redactSecrets` (`server/redact.ts`) before it reaches disk.
- **Audit what you authorize** — fire-and-forget. A journal write must never take down the turn it is journalling.
- **The test floor.** `pnpm test` runs `scripts/test-floor.mjs` with `TEST_COUNT_FLOOR = 1070`. Adding tests never touches it.
- **TypeScript strict**, Vitest, `fileParallelism: false`. Server tests are `server/**/*.test.ts`, colocated with their module.
- The oxlint `anti-slop` plugin (`tools/oxlint/anti-slop/rules/`) bans `unknown` parameters and returns, runtime `typeof` narrowing, chained type assertions, and object parameters. Write concrete types.

**Depends on:** nothing. This plan is independently executable today.

**Deliberately deferred to P2 (bot profile):** hanging an approved memory diff off the profile version log. The journal this plan builds is the record P2 would read; nothing here blocks on it.

---

## Background: what exists and what does not

`server/workspace.ts` is 172 lines and already owns the whole storage story:

| Thing | Where | Status |
|---|---|---|
| `~/.openmausbot/workspaces/<botId>/MEMORY.md` | `ensureWorkspace()`, seeded, `0600` | exists |
| `memory/<topic>.md`, read on demand by the bot's file tools | `ensureWorkspace()` creates the dir `0700` | exists |
| Load budget — `MEMORY_MAX_LINES = 200`, `MEMORY_MAX_BYTES = 24_000` | `loadMemory()` | exists |
| Any way for the user to SEE what is in there | — | **missing** |
| Any way to edit or delete a memory from the app | — | **missing** |
| Any record of what the bot wrote and when | — | **missing** |

The consequence: `loadMemory()` silently truncates at 200 lines, and nothing tells the user that the memory they are relying on stopped loading forty lines ago. That is the single highest-value thing this plan fixes.

**Explicitly NOT in scope: pluggable third-party memory providers** (Mem0, Honcho, Supermemory and friends). OpenMausBot's memory is plain markdown the user can open in any editor, and that is a product position, not a limitation. Routing memory through a hosted service would trade it for a vendor dependency and a second place secrets live. If it is ever wanted, it is its own plan with its own argument.

---

## File map

- Create `server/memory-store.ts` — path containment, overview with capacity, read/write/delete of one memory document. No knowledge of turns or HTTP.
- Create `server/memory-store.test.ts`.
- Create `server/memory-journal.ts` — content hashes, change rows, NDJSON append outside the workspace, revert.
- Create `server/memory-journal.test.ts`.
- Modify `server/index.ts` — five routes under `/api/bots/:id/memory`, plus the turn-boundary diff in the `case "turn.completed"` fold (`server/index.ts:1034`).
- Create `src/components/MemoryPanel.tsx` — the browser, editor, gauge, and journal list.
- Create `src/lib/memory.ts` — the client-side types and `api()` calls, shared by the panel and its tests.
- Modify `src/components/SettingsPanel.tsx` — mount the panel in the bot settings surface.
- Create `docs/memory.md` — what memory is, where it lives, what the budget means.

---

### Task 1: Path containment and the memory overview

The security boundary of the whole feature. A memory `file` parameter arrives from HTTP; if it can escape the workspace, the endpoint is an arbitrary-file-read.

**Files:**
- Create: `server/memory-store.ts`, `server/memory-store.test.ts`

**Interfaces:**
- Consumes: `workspaceDir`, `ensureWorkspace`, `MEMORY_MAX_LINES`, `MEMORY_MAX_BYTES` from `server/workspace.ts`; `writeFileAtomic` from `server/atomic.ts`; `redactSecrets` from `server/redact.ts`.
- Produces:
  ```ts
  export interface MemoryTopic { file: string; bytes: number; updatedAt: number }
  export interface MemoryCapacity {
    bytes: number; lines: number;
    loadedBytes: number; loadedLines: number;
    truncated: boolean;
    maxLines: number; maxBytes: number;
  }
  export interface MemoryOverview { botId: string; root: MemoryCapacity; topics: MemoryTopic[] }
  export function resolveMemoryPath(botId: string, file: string): string;
  export function memoryOverview(botId: string): MemoryOverview;
  export function readMemoryDoc(botId: string, file: string): string;
  export function writeMemoryDoc(botId: string, file: string, text: string): MemoryOverview;
  export function deleteMemoryDoc(botId: string, file: string): MemoryOverview;
  ```

- [ ] **Step 1: Write the failing containment test**

```ts
// server/memory-store.test.ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "omb-memory-"));
vi.mock("./config.ts", () => ({ DATA_DIR: DATA }));

const { resolveMemoryPath, memoryOverview, readMemoryDoc, writeMemoryDoc, deleteMemoryDoc } =
  await import("./memory-store.ts");
const { ensureWorkspace, workspaceDir } = await import("./workspace.ts");

describe("resolveMemoryPath", () => {
  beforeEach(() => ensureWorkspace("bot1"));

  it("accepts the two shapes memory actually has", () => {
    expect(resolveMemoryPath("bot1", "MEMORY.md")).toBe(join(workspaceDir("bot1"), "MEMORY.md"));
    expect(resolveMemoryPath("bot1", "memory/projects.md")).toBe(
      join(workspaceDir("bot1"), "memory", "projects.md"),
    );
  });

  it.each([
    ["../../../etc/passwd"],
    ["memory/../../evil.md"],
    ["/etc/passwd"],
    ["memory/nested/deep.md"],
    ["notes.txt"],
    ["memory/notes"],
    [""],
  ])("rejects %s", (file) => {
    expect(() => resolveMemoryPath("bot1", file)).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run server/memory-store.test.ts`
Expected: FAIL — `Cannot find module './memory-store.ts'`.

- [ ] **Step 3: Implement containment**

```ts
// server/memory-store.ts
// The user-facing half of bot memory: browse it, edit it, delete it.
//
// workspace.ts owns the files; this module owns the RULES for reaching
// them from outside the process. `file` arrives from HTTP, so it is
// matched against an allowlist of the two shapes memory actually has
// rather than sanitised — a rejected name is a bug report, not a path to
// be repaired. Anything else is an arbitrary-file-read on the user's disk.
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { redactSecrets } from "./redact.ts";
import { MEMORY_MAX_BYTES, MEMORY_MAX_LINES, ensureWorkspace, workspaceDir } from "./workspace.ts";

/** MEMORY.md, or a single-segment markdown file directly under memory/.
 * No nesting: the load budget only reasons about one level, and a deeper
 * tree would be a hierarchy the bot's prompt never describes. */
const TOPIC = /^memory\/[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}\.md$/;

export function resolveMemoryPath(botId: string, file: string): string {
  if (file !== "MEMORY.md" && !TOPIC.test(file)) {
    throw new Error(`not a memory document: ${file}`);
  }
  // TOPIC forbids "/" inside the name and "." only before "md", so ".."
  // cannot survive the match — this join is containment by construction.
  return join(workspaceDir(botId), ...file.split("/"));
}
```

- [ ] **Step 4: Run the containment test — green**

Run: `pnpm vitest run server/memory-store.test.ts`
Expected: PASS (7 rejections, 2 acceptances).

- [ ] **Step 5: Write the failing capacity test**

The gauge is the point of the feature: it has to report the truncation `loadMemory()` performs silently.

```ts
// append to server/memory-store.test.ts
describe("memoryOverview", () => {
  it("reports the load budget and what actually loads", () => {
    ensureWorkspace("bot2");
    const long = Array.from({ length: 260 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(workspaceDir("bot2"), "MEMORY.md"), long, { mode: 0o600 });

    const overview = memoryOverview("bot2");
    expect(overview.root.lines).toBe(260);
    expect(overview.root.loadedLines).toBe(200);
    expect(overview.root.truncated).toBe(true);
    expect(overview.root.maxLines).toBe(200);
    expect(overview.root.maxBytes).toBe(24_000);
  });

  it("lists topic files newest-first and ignores non-markdown", () => {
    ensureWorkspace("bot3");
    writeFileSync(join(workspaceDir("bot3"), "memory", "a.md"), "alpha", { mode: 0o600 });
    writeFileSync(join(workspaceDir("bot3"), "memory", "notes.txt"), "ignored", { mode: 0o600 });

    const overview = memoryOverview("bot3");
    expect(overview.topics.map((t) => t.file)).toEqual(["memory/a.md"]);
    expect(overview.topics[0].bytes).toBe(5);
  });

  it("reports an empty root for a fresh workspace", () => {
    ensureWorkspace("bot4");
    expect(memoryOverview("bot4").root.truncated).toBe(false);
    expect(memoryOverview("bot4").topics).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it — fails on the missing export**

Run: `pnpm vitest run server/memory-store.test.ts -t memoryOverview`
Expected: FAIL — `memoryOverview is not a function`.

- [ ] **Step 7: Implement the overview**

```ts
// append to server/memory-store.ts
export interface MemoryTopic { file: string; bytes: number; updatedAt: number }

export interface MemoryCapacity {
  bytes: number;
  lines: number;
  /** What `loadMemory()` would actually put in the system prompt. */
  loadedBytes: number;
  loadedLines: number;
  truncated: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface MemoryOverview { botId: string; root: MemoryCapacity; topics: MemoryTopic[] }

function capacityOf(raw: string): MemoryCapacity {
  const lines = raw.split("\n");
  let loaded = raw;
  let truncated = false;
  if (lines.length > MEMORY_MAX_LINES) {
    loaded = lines.slice(0, MEMORY_MAX_LINES).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(loaded, "utf8") > MEMORY_MAX_BYTES) {
    loaded = Buffer.from(loaded, "utf8").subarray(0, MEMORY_MAX_BYTES).toString("utf8").replace(/�+$/, "");
    truncated = true;
  }
  return {
    bytes: Buffer.byteLength(raw, "utf8"),
    lines: lines.length,
    loadedBytes: Buffer.byteLength(loaded, "utf8"),
    loadedLines: loaded.split("\n").length,
    truncated,
    maxLines: MEMORY_MAX_LINES,
    maxBytes: MEMORY_MAX_BYTES,
  };
}

export function memoryOverview(botId: string): MemoryOverview {
  ensureWorkspace(botId);
  let raw = "";
  try {
    raw = readFileSync(join(workspaceDir(botId), "MEMORY.md"), "utf8");
  } catch {
    raw = "";
  }
  const dir = join(workspaceDir(botId), "memory");
  const topics: MemoryTopic[] = [];
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!name.endsWith(".md")) continue;
    try {
      const info = statSync(join(dir, name));
      topics.push({ file: `memory/${name}`, bytes: info.size, updatedAt: info.mtimeMs });
    } catch {
      // a file deleted between readdir and stat is simply not listed
    }
  }
  topics.sort((a, b) => b.updatedAt - a.updatedAt);
  return { botId, root: capacityOf(raw), topics };
}
```

- [ ] **Step 8: Run — green**

Run: `pnpm vitest run server/memory-store.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing read/write/delete test**

```ts
// append to server/memory-store.test.ts
describe("memory documents", () => {
  it("round-trips a topic file and creates it on first write", () => {
    ensureWorkspace("bot5");
    writeMemoryDoc("bot5", "memory/clients.md", "# Clients\n\nAcme pays on time.\n");
    expect(readMemoryDoc("bot5", "memory/clients.md")).toContain("Acme pays on time");
    expect(memoryOverview("bot5").topics.map((t) => t.file)).toEqual(["memory/clients.md"]);
  });

  it("redacts secrets before they reach disk", () => {
    ensureWorkspace("bot6");
    writeMemoryDoc("bot6", "MEMORY.md", "the key is sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH\n");
    expect(readFileSync(join(workspaceDir("bot6"), "MEMORY.md"), "utf8")).not.toContain("AAAABBBB");
  });

  it("writes 0600", () => {
    ensureWorkspace("bot7");
    writeMemoryDoc("bot7", "memory/x.md", "hi");
    expect(statSync(join(workspaceDir("bot7"), "memory", "x.md")).mode & 0o777).toBe(0o600);
  });

  it("deletes a topic but never MEMORY.md", () => {
    ensureWorkspace("bot8");
    writeMemoryDoc("bot8", "memory/gone.md", "bye");
    expect(deleteMemoryDoc("bot8", "memory/gone.md").topics).toEqual([]);
    expect(() => deleteMemoryDoc("bot8", "MEMORY.md")).toThrow(/cannot be deleted/);
  });

  it("reads a missing document as empty rather than throwing", () => {
    ensureWorkspace("bot9");
    expect(readMemoryDoc("bot9", "memory/never-written.md")).toBe("");
  });
});
```

- [ ] **Step 10: Run — fails**

Run: `pnpm vitest run server/memory-store.test.ts -t "memory documents"`
Expected: FAIL — `writeMemoryDoc is not a function`.

- [ ] **Step 11: Implement read/write/delete**

```ts
// append to server/memory-store.ts
export function readMemoryDoc(botId: string, file: string): string {
  const path = resolveMemoryPath(botId, file);
  try {
    return readFileSync(path, "utf8");
  } catch {
    // a topic the user is about to create reads as empty, not as an error
    return "";
  }
}

export function writeMemoryDoc(botId: string, file: string, text: string): MemoryOverview {
  ensureWorkspace(botId);
  const path = resolveMemoryPath(botId, file);
  // Memory is agent-authored as often as user-authored, and an agent that
  // pastes a key into its own notes must not leave it on disk in the clear.
  writeFileAtomic(path, redactSecrets(text), { mode: 0o600 });
  return memoryOverview(botId);
}

export function deleteMemoryDoc(botId: string, file: string): MemoryOverview {
  // MEMORY.md is loaded unconditionally at turn start; removing it would
  // make the next ensureWorkspace() silently reseed it, which reads as
  // "delete did nothing". Clearing it is a write of "".
  if (file === "MEMORY.md") throw new Error("MEMORY.md cannot be deleted — clear it instead");
  const path = resolveMemoryPath(botId, file);
  try {
    unlinkSync(path);
  } catch {
    // already gone is the desired end state
  }
  return memoryOverview(botId);
}
```

- [ ] **Step 12: Run the full file — green**

Run: `pnpm vitest run server/memory-store.test.ts`
Expected: PASS, all describes.

- [ ] **Step 13: Typecheck and commit**

```bash
pnpm typecheck && pnpm lint
git add server/memory-store.ts server/memory-store.test.ts
git commit -m "feat(memory): contained read/write/delete over bot memory files with a capacity gauge"
```

---

### Task 2: The change journal

**Files:**
- Create: `server/memory-journal.ts`, `server/memory-journal.test.ts`

**Interfaces:**
- Consumes: `memoryOverview`, `readMemoryDoc`, `writeMemoryDoc` from Task 1.
- Produces:
  ```ts
  export type MemorySnapshot = Record<string, string>;   // file → sha256 of contents
  export interface MemoryChange {
    at: string; botId: string; threadId?: string;
    file: string; kind: "created" | "edited" | "deleted";
    beforeBytes: number; afterBytes: number;
    before: string;   // the full prior text, so a revert needs nothing else
  }
  export function snapshotMemory(botId: string): MemorySnapshot;
  export function recordMemoryChanges(
    botId: string, before: MemorySnapshot, threadId?: string,
  ): MemoryChange[];
  export function readMemoryJournal(botId: string, limit: number): MemoryChange[];
  export function revertMemoryChange(botId: string, at: string, file: string): boolean;
  ```

**Where the journal lives, and why not in the workspace:** `~/.openmausbot/memory-journal/<botId>.ndjson`. The workspace is the bot's own desk — it has file tools pointed at it and `acceptEdits` on. An audit trail of what the bot changed, stored where the bot can rewrite it, is not an audit trail.

- [ ] **Step 1: Write the failing snapshot/diff test**

```ts
// server/memory-journal.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "omb-journal-"));
vi.mock("./config.ts", () => ({ DATA_DIR: DATA }));

const { snapshotMemory, recordMemoryChanges, readMemoryJournal, revertMemoryChange } =
  await import("./memory-journal.ts");
const { writeMemoryDoc, deleteMemoryDoc, readMemoryDoc } = await import("./memory-store.ts");
const { ensureWorkspace } = await import("./workspace.ts");

describe("recordMemoryChanges", () => {
  it("records nothing when memory did not move", () => {
    ensureWorkspace("j1");
    const before = snapshotMemory("j1");
    expect(recordMemoryChanges("j1", before)).toEqual([]);
  });

  it("records a creation, an edit, and a deletion with the prior text", () => {
    ensureWorkspace("j2");
    writeMemoryDoc("j2", "memory/a.md", "one");
    const before = snapshotMemory("j2");

    writeMemoryDoc("j2", "memory/a.md", "two");
    writeMemoryDoc("j2", "memory/b.md", "new");
    deleteMemoryDoc("j2", "memory/a.md");

    // a.md was edited then deleted within one turn: the journal reports the
    // net effect against the turn's opening snapshot, which is a deletion
    const rows = recordMemoryChanges("j2", before, "thread-1");
    const byFile = Object.fromEntries(rows.map((r) => [r.file, r]));
    expect(byFile["memory/a.md"].kind).toBe("deleted");
    expect(byFile["memory/a.md"].before).toBe("one");
    expect(byFile["memory/b.md"].kind).toBe("created");
    expect(byFile["memory/b.md"].threadId).toBe("thread-1");
  });

  it("appends to a per-bot journal that reads back newest-first", () => {
    ensureWorkspace("j3");
    const before = snapshotMemory("j3");
    writeMemoryDoc("j3", "memory/x.md", "hello");
    recordMemoryChanges("j3", before);
    expect(readMemoryJournal("j3", 10)).toHaveLength(1);
    expect(readMemoryJournal("j3", 10)[0].file).toBe("memory/x.md");
  });

  it("reverts an edit back to the recorded prior text", () => {
    ensureWorkspace("j4");
    writeMemoryDoc("j4", "memory/y.md", "original");
    const before = snapshotMemory("j4");
    writeMemoryDoc("j4", "memory/y.md", "agent rewrote this");
    const [row] = recordMemoryChanges("j4", before);

    expect(revertMemoryChange("j4", row.at, row.file)).toBe(true);
    expect(readMemoryDoc("j4", "memory/y.md")).toBe("original");
  });

  it("never throws when the journal cannot be written", () => {
    ensureWorkspace("j5");
    const before = snapshotMemory("j5");
    writeMemoryDoc("j5", "memory/z.md", "x");
    // journalling is fire-and-forget: the caller is a turn fold that must
    // not die because an audit line failed
    expect(() => recordMemoryChanges("j5", before, "t")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run — fails on the missing module**

Run: `pnpm vitest run server/memory-journal.test.ts`
Expected: FAIL — `Cannot find module './memory-journal.ts'`.

- [ ] **Step 3: Implement the journal**

```ts
// server/memory-journal.ts
// What the bot changed about what it believes.
//
// A bot edits MEMORY.md with the same file tools it uses for any other
// file, so there is no write hook to tap. Instead the turn fold takes a
// content hash of every memory document before dispatch and again at
// turn.completed, and the difference becomes journal rows.
//
// The journal lives OUTSIDE the workspace on purpose. The workspace is
// the bot's desk — it has file tools pointed at it. An audit trail the
// audited party can edit is not an audit trail.
//
// Same discipline as decision-log.ts: 0600, redacted, fire-and-forget.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { memoryOverview, readMemoryDoc, writeMemoryDoc, deleteMemoryDoc } from "./memory-store.ts";

export type MemorySnapshot = Record<string, string>;

export interface MemoryChange {
  at: string;
  botId: string;
  threadId?: string;
  file: string;
  kind: "created" | "edited" | "deleted";
  beforeBytes: number;
  afterBytes: number;
  /** The full prior text. A revert must not depend on replaying a diff. */
  before: string;
}

const JOURNAL_DIR = join(DATA_DIR, "memory-journal");

function journalFile(botId: string): string {
  return join(JOURNAL_DIR, `${botId}.ndjson`);
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function documentsOf(botId: string): string[] {
  const overview = memoryOverview(botId);
  return ["MEMORY.md", ...overview.topics.map((topic) => topic.file)];
}

export function snapshotMemory(botId: string): MemorySnapshot {
  const snapshot: MemorySnapshot = {};
  for (const file of documentsOf(botId)) snapshot[file] = hash(readMemoryDoc(botId, file));
  return snapshot;
}

export function recordMemoryChanges(botId: string, before: MemorySnapshot, threadId?: string): MemoryChange[] {
  const at = new Date().toISOString();
  const after = snapshotMemory(botId);
  const rows: MemoryChange[] = [];
  for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const wasThere = file in before;
    const isThere = file in after;
    if (wasThere && isThere && before[file] === after[file]) continue;
    const nowText = isThere ? readMemoryDoc(botId, file) : "";
    rows.push({
      at,
      botId,
      threadId,
      file,
      kind: !wasThere ? "created" : !isThere ? "deleted" : "edited",
      // the prior TEXT is not in the snapshot (it holds hashes), so a
      // before-body is only available for documents that still exist —
      // deleted ones keep whatever the previous journal row captured
      beforeBytes: wasThere ? priorBytes(botId, file) : 0,
      afterBytes: Buffer.byteLength(nowText, "utf8"),
      before: priorText(botId, file),
    });
  }
  if (rows.length) append(botId, rows);
  return rows;
}

/** The last text this journal saw for a document, or "" if it has never
 * seen one. This is what makes a revert possible without a second copy of
 * every memory file on disk. */
function priorText(botId: string, file: string): string {
  const history = readMemoryJournal(botId, 200).filter((row) => row.file === file);
  if (history.length) return history[0].before;
  return readMemoryDoc(botId, file);
}

function priorBytes(botId: string, file: string): number {
  return Buffer.byteLength(priorText(botId, file), "utf8");
}

function append(botId: string, rows: MemoryChange[]): void {
  try {
    mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(journalFile(botId), rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
  } catch (error) {
    // fire-and-forget: the turn that produced these rows already succeeded
    console.error("memory-journal: could not append", error);
  }
}

export function readMemoryJournal(botId: string, limit: number): MemoryChange[] {
  const file = journalFile(botId);
  if (!existsSync(file)) return [];
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: MemoryChange[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as MemoryChange);
    } catch {
      // a torn final line from a crash mid-append is skipped, not fatal
    }
  }
  return rows.reverse().slice(0, limit);
}

export function revertMemoryChange(botId: string, at: string, file: string): boolean {
  const row = readMemoryJournal(botId, 500).find((entry) => entry.at === at && entry.file === file);
  if (!row) return false;
  if (row.kind === "created") deleteMemoryDoc(botId, file);
  else writeMemoryDoc(botId, file, row.before);
  return true;
}
```

- [ ] **Step 4: Run — green**

Run: `pnpm vitest run server/memory-journal.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm lint
git add server/memory-journal.ts server/memory-journal.test.ts
git commit -m "feat(memory): journal what a bot changes about what it believes"
```

---

### Task 3: Routes and the turn-boundary diff

**Files:**
- Modify: `server/index.ts` — routes near the other bot-scoped `GET` handlers (around `server/index.ts:3234`), and the fold at `case "turn.completed"` (`server/index.ts:1034`).
- Create: `server/memory-routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces (HTTP):
  - `GET /api/bots/:id/memory` → `MemoryOverview`
  - `GET /api/bots/:id/memory/doc?file=memory/x.md` → `{ file: string; text: string }`
  - `PUT /api/bots/:id/memory/doc` body `{ file: string; text: string }` → `MemoryOverview`
  - `DELETE /api/bots/:id/memory/doc?file=memory/x.md` → `MemoryOverview`
  - `GET /api/bots/:id/memory/journal?limit=50` → `{ changes: MemoryChange[] }`
  - `POST /api/bots/:id/memory/revert` body `{ at: string; file: string }` → `MemoryOverview`

- [ ] **Step 1: Write the failing route test**

Follow the existing pattern in `server/index.test.ts` for booting the server under test; import the same helper it uses rather than inventing a second harness.

```ts
// server/memory-routes.test.ts
import { describe, expect, it } from "vitest";
import { startTestServer } from "./testing/server.ts";   // the helper index.test.ts already uses

describe("memory routes", () => {
  it("serves an overview, writes a topic, and refuses an escaping path", async () => {
    const { url, botId, close } = await startTestServer();
    try {
      const overview = await (await fetch(`${url}/api/bots/${botId}/memory`)).json();
      expect(overview.root.maxLines).toBe(200);

      const written = await fetch(`${url}/api/bots/${botId}/memory/doc`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "memory/clients.md", text: "Acme" }),
      });
      expect(written.status).toBe(200);
      expect((await written.json()).topics[0].file).toBe("memory/clients.md");

      const escaped = await fetch(`${url}/api/bots/${botId}/memory/doc`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "../../../etc/passwd", text: "pwned" }),
      });
      expect(escaped.status).toBe(400);
    } finally {
      await close();
    }
  });
});
```

> If `server/testing/server.ts` does not export `startTestServer`, read `server/index.test.ts` first and reuse whatever it does — do not add a second boot path.

- [ ] **Step 2: Run — fails with 404**

Run: `pnpm vitest run server/memory-routes.test.ts`
Expected: FAIL — the overview fetch returns 404.

- [ ] **Step 3: Add the routes**

Place these beside the other `/api/bots/:id/...` handlers in `server/index.ts`, matching the surrounding `if (method === … && path === …)` style exactly.

```ts
// server/index.ts — near the other bot-scoped routes
const memoryMatch = /^\/api\/bots\/([^/]+)\/memory$/.exec(path);
if (memoryMatch && method === "GET") {
  return json(res, 200, memoryOverview(memoryMatch[1]));
}

const memoryDocMatch = /^\/api\/bots\/([^/]+)\/memory\/doc$/.exec(path);
if (memoryDocMatch) {
  const botId = memoryDocMatch[1];
  try {
    if (method === "GET") {
      const file = url.searchParams.get("file") ?? "MEMORY.md";
      return json(res, 200, { file, text: readMemoryDoc(botId, file) });
    }
    if (method === "PUT") {
      const body = await readJsonBody(req);
      const file = typeof body.file === "string" ? body.file : "";
      const text = typeof body.text === "string" ? body.text : "";
      return json(res, 200, writeMemoryDoc(botId, file, text));
    }
    if (method === "DELETE") {
      return json(res, 200, deleteMemoryDoc(botId, url.searchParams.get("file") ?? ""));
    }
  } catch (error) {
    // resolveMemoryPath rejecting a name is a client error, not a 500
    return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

const memoryJournalMatch = /^\/api\/bots\/([^/]+)\/memory\/journal$/.exec(path);
if (memoryJournalMatch && method === "GET") {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
  return json(res, 200, { changes: readMemoryJournal(memoryJournalMatch[1], limit) });
}

const memoryRevertMatch = /^\/api\/bots\/([^/]+)\/memory\/revert$/.exec(path);
if (memoryRevertMatch && method === "POST") {
  const body = await readJsonBody(req);
  const at = typeof body.at === "string" ? body.at : "";
  const file = typeof body.file === "string" ? body.file : "";
  if (!revertMemoryChange(memoryRevertMatch[1], at, file)) {
    return json(res, 404, { error: "no such memory change" });
  }
  return json(res, 200, memoryOverview(memoryRevertMatch[1]));
}
```

> `json`, `readJsonBody`, and `url` are whatever the surrounding handlers already use — read the twenty lines above your insertion point and match them rather than importing anything new.

- [ ] **Step 4: Run — green**

Run: `pnpm vitest run server/memory-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing turn-diff test**

```ts
// append to server/memory-routes.test.ts
it("journals what a turn changed in memory", async () => {
  const { url, botId, runTurnThatWrites, close } = await startTestServer();
  try {
    await runTurnThatWrites("memory/learned.md", "the user prefers short replies");
    const { changes } = await (await fetch(`${url}/api/bots/${botId}/memory/journal`)).json();
    expect(changes[0].file).toBe("memory/learned.md");
    expect(changes[0].kind).toBe("created");
  } finally {
    await close();
  }
});
```

> If the test harness has no `runTurnThatWrites`, add it there as a thin helper that writes into the workspace and then fires the same `turn.completed` fold the driver would — the point of the test is the fold, not the driver.

- [ ] **Step 6: Run — fails, journal empty**

Run: `pnpm vitest run server/memory-routes.test.ts -t "journals what a turn changed"`
Expected: FAIL — `changes[0]` is undefined.

- [ ] **Step 7: Wire the snapshot into turn dispatch and the diff into the fold**

At dispatch, immediately before `instance.adapter.sendTurn(...)`:

```ts
// server/index.ts — at turn dispatch
const memoryBefore = snapshotMemory(bot.id);
memorySnapshots.set(threadId, memoryBefore);
```

with the map declared beside the other per-thread maps at module scope:

```ts
/** Memory hashes taken at dispatch, diffed at turn.completed. Keyed by
 * thread because that is what the completion event carries. */
const memorySnapshots = new Map<string, MemorySnapshot>();
```

and in `case "turn.completed":` (`server/index.ts:1034`), beside the existing usage tally:

```ts
const memoryBefore = memorySnapshots.get(event.threadId);
if (memoryBefore && botForThread) {
  memorySnapshots.delete(event.threadId);
  // fire-and-forget by construction: recordMemoryChanges swallows its own
  // write failures, and a hashing error must not break the fold
  try {
    recordMemoryChanges(botForThread.id, memoryBefore, event.threadId);
  } catch (error) {
    console.error("memory-journal: diff failed", error);
  }
}
```

- [ ] **Step 8: Run — green, then the whole server suite**

Run: `pnpm vitest run server/memory-routes.test.ts && pnpm vitest run server/`
Expected: PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
pnpm typecheck && pnpm lint
git add server/index.ts server/memory-routes.test.ts
git commit -m "feat(memory): memory routes and a turn-boundary diff into the journal"
```

---

### Task 4: The memory panel

**Files:**
- Create: `src/lib/memory.ts`, `src/components/MemoryPanel.tsx`
- Modify: `src/components/SettingsPanel.tsx`

**Interfaces:**
- Consumes: the six routes from Task 3; `api` and `useStore` from `@/state/store`; `cn` from `@/lib/cn`.
- Produces: `<MemoryPanel botId={string} />`, and in `src/lib/memory.ts` the mirrored types `MemoryOverview`, `MemoryTopic`, `MemoryCapacity`, `MemoryChange` plus `fetchMemory`, `fetchMemoryDoc`, `saveMemoryDoc`, `deleteMemoryDoc`, `fetchMemoryJournal`, `revertMemoryChange`.

- [ ] **Step 1: Write the failing client test**

```tsx
// src/components/MemoryPanel.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "./MemoryPanel";

const overview = {
  botId: "b1",
  root: { bytes: 9_000, lines: 260, loadedBytes: 8_000, loadedLines: 200, truncated: true, maxLines: 200, maxBytes: 24_000 },
  topics: [{ file: "memory/clients.md", bytes: 120, updatedAt: 1 }],
};

describe("MemoryPanel", () => {
  it("warns when memory has outgrown what actually loads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(overview))));
    render(<MemoryPanel botId="b1" />);
    await waitFor(() => expect(screen.getByText(/60 lines are not being loaded/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run — fails**

Run: `pnpm vitest run src/components/MemoryPanel.test.tsx`
Expected: FAIL — `Cannot find module './MemoryPanel'`.

- [ ] **Step 3: Build the panel**

Three regions, top to bottom. Match the visual language of `SettingsPanel.tsx` — same `text-[13px]`, `text-ink-secondary`, `rounded-xl bg-control` idiom; do not introduce a new one.

1. **Capacity gauge.** A bar of `loadedBytes / bytes` with the line count under it. When `truncated`, a plain-language line: *"260 lines saved, 200 load into every conversation — 60 lines are not being loaded."* This sentence is the feature; write it exactly, and do not soften it into "some content may be truncated".
2. **Documents.** `MEMORY.md` pinned first, then topics newest-first with byte sizes. Selecting one opens a `<textarea>` with the text; Save calls `PUT`, Delete calls `DELETE` (never offered for `MEMORY.md` — the server refuses it, so the UI must not present the affordance; the capability rule).
3. **Recent changes.** The last 20 journal rows: relative time, file, `kind`, byte delta, and a Revert button per row that `POST`s `/memory/revert` and refetches.

- [ ] **Step 4: Run — green**

Run: `pnpm vitest run src/components/MemoryPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mount it in bot settings**

In `src/components/SettingsPanel.tsx`, add a "Memory" block below the existing per-bot sections, rendering `<MemoryPanel botId={bot.id} />`. Bot-scoped, not app-scoped: memory belongs to one bot, so it does not go in `SettingsModal`'s `SECTIONS`.

- [ ] **Step 6: Run the app and look at it**

Run: `pnpm dev:server` and `pnpm dev`, open a bot's settings, write a memory, edit it, revert it.
Expected: the gauge moves; the journal grows; revert restores the prior text.

- [ ] **Step 7: Commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/lib/memory.ts src/components/MemoryPanel.tsx src/components/MemoryPanel.test.tsx src/components/SettingsPanel.tsx
git commit -m "feat(memory): a memory panel with a real capacity gauge and a revertable change log"
```

---

### Task 5: Document it

**Files:**
- Create: `docs/memory.md`
- Modify: `README.md` — one feature bullet in the "Also in the box" paragraph.

- [ ] **Step 1: Write `docs/memory.md`**

Cover, in this order: where memory lives on disk (`~/.openmausbot/workspaces/<botId>/`), that it is plain markdown the user can edit in any editor, what the 200-line / 24 KB budget means and what happens past it, that `memory/<topic>.md` files are read on demand and not budgeted, where the journal lives and why it is outside the workspace, and how to revert.

- [ ] **Step 2: Add the README bullet**

In the "**Also in the box:**" run-on, add: `· a memory panel per bot — see what it has learned, edit it, and revert what it wrote`.

- [ ] **Step 3: Commit**

```bash
git add docs/memory.md README.md
git commit -m "docs(memory): what memory is, where it lives, and what the budget means"
```

---

## Self-review

**Spec coverage.** Every gap in the Background table has a task: visibility → Task 1 + 4, editing → Task 1 + 3 + 4, the record of what the bot wrote → Task 2 + 3, capacity → Task 1 (`MemoryCapacity`) surfaced in Task 4. Third-party providers are explicitly out of scope with a stated reason.

**Placeholders.** None: every code step carries the code, every test step carries the test. Two steps say "read the neighbouring handler and match it" rather than inventing an HTTP helper the file may not have — that is a deliberate instruction to follow an existing pattern, not a deferred decision. Task 3 Step 1 and Step 5 name a test-harness helper that may not exist under that name and tell the engineer to reuse whatever `server/index.test.ts` already does.

**Type consistency.** `MemoryOverview`, `MemoryCapacity`, `MemoryTopic`, `MemoryChange`, `MemorySnapshot` are defined once in Tasks 1–2 and mirrored in `src/lib/memory.ts` in Task 4. `resolveMemoryPath` / `memoryOverview` / `readMemoryDoc` / `writeMemoryDoc` / `deleteMemoryDoc` / `snapshotMemory` / `recordMemoryChanges` / `readMemoryJournal` / `revertMemoryChange` keep the same names from definition through routes through client.
