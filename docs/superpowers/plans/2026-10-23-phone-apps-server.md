# Phone apps as bot tools: server plumbing (sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired phone registers the apps it allows, a bot gets one `PHONE_*` tool per allowed app through a fifth internal MCP kind `device`, every call becomes a job the phone long-polls, runs and answers, and sends go through the existing "Send on your behalf?" hold.

**Architecture:** Three new server areas with explicit deps, wired from `server/index.ts` as the composition root: `server/phones/` (registry, job queue, tool catalog, per-bot verdict, MCP host, copied from the shapes of `server/shared-computers.ts` and `server/highlevel/`), `server/routes/phones.ts` (the phone's REST surface: register, long-poll, lease, result), and `server/outbound-hold.ts` (the Composio outbound hold moved out of `index.ts` so the device kind can call it too). The phone is identified by what authenticated the request (companion device header or Cloud session), never by its body. No phone pack is in this plan; the phone side is sub-projects B and C.

**Tech Stack:** Node 24 + TypeScript (type-stripped at runtime, so `import type` for types), zod, vitest, React desktop UI, companion sidecar.

**Spec:** `docs/superpowers/specs/2026-10-23-phone-apps-as-bot-tools-design.md` (copied from SupaMaus/mausbot-mobile, branch `feat/phone-apps`). Sections 1 to 4 and 7 are this plan; 5 and 6 are B/C and E.

## Global Constraints

- `server/index.ts` is pinned at **16924 lines** by `scripts/testing/file-size-ratchet.test.ts` and may only shrink. Task 8 moves ~100 lines out; every later `index.ts` edit is written onto an existing line or joins neighbouring lines, and the pin is lowered to the final count at the end (Task 15).
- `server/index.ts` may gain **no path guard**: `scripts/testing/index-route-ratchet.test.ts` holds exact counts of `path === "/`, `path.match(`, `path.startsWith(`. New routes live in `server/routes/phones.ts`. The internal MCP handler compares against the constant `PHONE_INTERNAL_MCP_PATH` (no `"/` literal), as HighLevel does.
- `shared/wire.ts` is 994 lines; the ratchet lists any file over 1000. Budget: 4 new lines.
- The companion sidecar denies `/api/devices` on purpose (`companion/src/routes.ts:229`). The phone's routes are `/api/phones/...`.
- The companion proxy's headers timeout is 30 s (`companion/src/proxy.ts:55`): the long poll answers within **20 s**.
- Kind name is `device` everywhere (`InternalCapability.kind`, `integrations.device`, `deviceMcp`, `OMB_MCP_TOKEN_DEVICE`, tools arrive as `mcp__device__PHONE_*`); `phone` already means the USB Android harness. The grant slug is `phone` because `shared/connector-scopes.ts` derives the toolkit from the `PHONE_` prefix.
- Tool names: reads start `PHONE_GET_` / `PHONE_LIST_` / `PHONE_SEARCH_` / `PHONE_FIND_`; the two sends are `PHONE_SEND_MESSAGE` and `PHONE_SEND_WHATSAPP` (classified outbound by `shared/outbound.ts` with no change).
- Timeouts (spec §2): in-turn read/write job 45 s, send job 120 s; the device kind's proxy timeout is 10 min (a held send waits up to the 9-minute outbound hold).
- Phone data never reaches the control plane; on the harness only the registry mirror (`phones.json`, mode 0o600) holds phone metadata, never a tool result.
- Copy rules: tool results carry `phone: { name, platform }`; an offline phone reads "<name> is offline. Open the MausBot app on it." in one sentence; the held note is `HELD_NOTE["approval.held.outbound"]`.
- Type-only imports must be `import type`.

## Review Focus

1. A phone that registers, goes away, and re-pairs under a new session on a Cloud home must not show twice: the registry dedupes on the phone's own `installId` inside one owner (Task 2 test "re-registration under a new key replaces the old record").
2. A job answered after its turn ended must not be applied or replayed: `complete()` on a finished job throws 409 and the result is dropped (Task 3 test "a late result is refused").
3. A bot whose phone grant was lowered while a call waited on the hold must not send: the dispatch-time re-check refuses (Task 9 test "grant lowered during the hold refuses the send").
4. A caller-chosen `x-openmausbot-companion-device` header on a plain loopback request must not mint a phone identity: `phoneKey` returns a companion key only when `x-openmausbot-companion` is `1` and the header matches `/^[\w-]{1,128}$/`, and `GET /api/phones` is admin-only (Task 5 test "a loopback request without the companion marker has no phone key").
5. The read-and-draft fence must keep stripping the device integration from confined routine runs so a watch routine cannot write to the phone yet (Task 10 test "a confined run has no device integration").

---

### Task 1: Shared vocabulary for phone apps

**Files:**
- Create: `shared/phone-apps.ts`
- Create: `shared/phone-apps.test.ts`
- Modify: `shared/wire.ts:354-361` (WireBot grants), `shared/wire.ts:990-993` (ServerFrame union)

**Interfaces:**
- Produces:
  ```ts
  export const PHONE_CAPABILITIES = ["calendar", "reminders", "contacts", "location", "home", "messages"] as const;
  export type PhoneCapability = (typeof PHONE_CAPABILITIES)[number];
  export type PhoneGrant = "read" | "write";
  /** Per-bot grant; an absent key is off. */
  export type PhoneApps = Partial<Record<PhoneCapability, PhoneGrant>>;
  export const PHONE_SLUG = "phone";
  export const PHONE_MCP_SERVER = "device";
  export const PHONE_PLATFORMS = ["ios", "android"] as const;
  export type PhonePlatform = (typeof PHONE_PLATFORMS)[number];
  export const PHONE_TOOL_NAMES = [
    "PHONE_LIST_EVENTS", "PHONE_GET_EVENT", "PHONE_FIND_FREE_TIME", "PHONE_CREATE_EVENT", "PHONE_UPDATE_EVENT", "PHONE_DELETE_EVENT", "PHONE_RESPOND_TO_INVITE",
    "PHONE_LIST_REMINDERS", "PHONE_CREATE_REMINDER", "PHONE_UPDATE_REMINDER", "PHONE_COMPLETE_REMINDER", "PHONE_DELETE_REMINDER",
    "PHONE_SEARCH_CONTACTS", "PHONE_GET_CONTACT", "PHONE_CREATE_CONTACT", "PHONE_UPDATE_CONTACT",
    "PHONE_GET_LOCATION", "PHONE_FIND_PLACES_NEARBY",
    "PHONE_LIST_HOME", "PHONE_SET_ACCESSORY", "PHONE_RUN_SCENE",
    "PHONE_SEND_MESSAGE", "PHONE_SEND_WHATSAPP",
  ] as const;
  export type PhoneToolName = (typeof PHONE_TOOL_NAMES)[number];
  export function isPhoneToolName(name: unknown): name is PhoneToolName;
  export function phoneToolCapability(name: PhoneToolName): PhoneCapability;
  /** GET/LIST/SEARCH/FIND read; everything else writes (isReadOnlyAction(name, "phone")). */
  export function isPhoneWrite(name: string): boolean;
  export function phoneToolSends(name: string): boolean;   // PHONE_SEND_*
  export function normalizePhoneApps(value: unknown): PhoneApps | null;   // unknown key or value → null; {} ok
  export const ALL_PHONE_APPS: PhoneApps;   // every capability "write"
  ```
  WireBot gains `phoneApps?: PhoneApps;` after `outbound` at `shared/wire.ts:361` with the one-line comment `/** Which of a paired phone's apps this bot may use; absent: the Chief gets all, others none (shared/phone-apps.ts). */`.
  ServerFrame gains, before the final `config` member: `/** A job is waiting for the phone whose registry key this is; it polls now. */` `| { kind: "device.job"; phone: string; id: string }`.

- [ ] **Step 1: Write the failing test** `shared/phone-apps.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { isOutboundTool, isReadOnlyTool } from "./outbound.ts";
import { ALL_PHONE_APPS, PHONE_CAPABILITIES, PHONE_TOOL_NAMES, isPhoneWrite, normalizePhoneApps, phoneToolCapability, phoneToolSends } from "./phone-apps.ts";

describe("phone tool vocabulary", () => {
  it("maps every tool to one capability", () => {
    for (const name of PHONE_TOOL_NAMES) expect(PHONE_CAPABILITIES).toContain(phoneToolCapability(name));
    expect(phoneToolCapability("PHONE_SEND_WHATSAPP")).toBe("messages");
    expect(phoneToolCapability("PHONE_FIND_PLACES_NEARBY")).toBe("location");
  });
  it("splits reads from writes by verb", () => {
    expect(PHONE_TOOL_NAMES.filter((n) => !isPhoneWrite(n))).toEqual(["PHONE_LIST_EVENTS", "PHONE_GET_EVENT", "PHONE_FIND_FREE_TIME", "PHONE_LIST_REMINDERS", "PHONE_SEARCH_CONTACTS", "PHONE_GET_CONTACT", "PHONE_GET_LOCATION", "PHONE_FIND_PLACES_NEARBY", "PHONE_LIST_HOME"]);
  });
  it("is classed by the existing outbound rules with no special case", () => {
    expect(isOutboundTool("PHONE_SEND_MESSAGE")).toBe(true);
    expect(isOutboundTool("mcp__device__PHONE_SEND_WHATSAPP")).toBe(true);
    expect(isOutboundTool("PHONE_CREATE_EVENT")).toBe(false);
    expect(isReadOnlyTool("PHONE_LIST_EVENTS")).toBe(true);
    expect(phoneToolSends("PHONE_SEND_MESSAGE")).toBe(true);
    expect(phoneToolSends("PHONE_CREATE_REMINDER")).toBe(false);
  });
  it("normalizes grants", () => {
    expect(normalizePhoneApps({ calendar: "read", messages: "write" })).toEqual({ calendar: "read", messages: "write" });
    expect(normalizePhoneApps({})).toEqual({});
    expect(normalizePhoneApps({ calendar: "full" })).toBeNull();
    expect(normalizePhoneApps({ health: "read" })).toBeNull();
    expect(normalizePhoneApps("read")).toBeNull();
    expect(Object.keys(ALL_PHONE_APPS)).toEqual([...PHONE_CAPABILITIES]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run shared/phone-apps.test.ts`
Expected: FAIL, cannot find module `./phone-apps.ts`.

- [ ] **Step 3: Implement `shared/phone-apps.ts`** with the exported names above. `phoneToolCapability` is a static `Record<PhoneToolName, PhoneCapability>`. `isPhoneWrite` calls `isReadOnlyAction(name, PHONE_SLUG)` from `./connector-scopes.ts`. Then add the two `shared/wire.ts` lines.

- [ ] **Step 4: Run tests and the wire budget**

Run: `pnpm vitest run shared/phone-apps.test.ts scripts/testing/file-size-ratchet.test.ts && wc -l shared/wire.ts`
Expected: PASS; `shared/wire.ts` ≤ 998 lines.

- [ ] **Step 5: Commit**

```bash
git add shared/phone-apps.ts shared/phone-apps.test.ts shared/wire.ts
git commit -m "feat(phones): shared vocabulary for phone apps, grants and the device.job frame"
```

---

### Task 2: Phone registry

**Files:**
- Create: `server/phones/registry.ts`, `server/phones/registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  import { z } from "zod";
  export const phoneRegistration = z.object({
    installId: z.string().regex(/^[\w-]{8,64}$/),
    name: z.string().min(1).max(120),
    platform: z.enum(PHONE_PLATFORMS),
    appVersion: z.string().max(40),
    timeZone: z.string().max(64),
    /** Capability → the OS grant the phone holds ("full", "limited", "when_in_use", "send", "listener"); present means allowed. */
    capabilities: z.record(z.enum(PHONE_CAPABILITIES), z.string().min(1).max(32)),
  }).strict();
  export type PhoneRegistration = z.infer<typeof phoneRegistration>;
  export type PhoneRecord = { key: string; owner: string; registration: PhoneRegistration; registeredAt: number; seen: number; lastUsedAt: number | null };
  /** What the owner's UI and the phone itself see. */
  export type PublicPhone = Omit<PhoneRecord, "owner"> & { online: boolean; busy: boolean };
  export const PHONE_ONLINE_MS = 60_000;
  export const MAX_PHONES = 20;
  export class PhoneRegistry {
    constructor(file: string, now?: () => number);
    /** Same key: update. Same owner + installId under another key: replace that record. */
    register(key: string, owner: string, registration: PhoneRegistration): PhoneRecord;   // throws {status:409} at MAX_PHONES
    get(key: string): PhoneRecord | undefined;
    seen(key: string): void;           // writes the mirror at most once a minute per key
    used(key: string): void;
    remove(key: string): boolean;
    list(owner: string | null, busy: (key: string) => boolean): PublicPhone[];   // null owner: every phone (desktop admin list)
    forOwner(owner: string): PhoneRecord[];
  }
  ```
  Mirror file shape: `{ version: 1, phones: PhoneRecord[] }`, written with `writeFileAtomic(file, text, { mode: 0o600 })`; a bad file warns and starts empty, as `LentComputers` does.

- [ ] **Step 1: Write the failing tests** `server/phones/registry.test.ts` (tmp dir per test with `mkdtempSync`, cleaned with `removeTempDir` from `server/testing/cleanup.ts`):

```ts
const reg = (over: Partial<PhoneRegistration> = {}): PhoneRegistration => ({ installId: "inst-aaaaaaaa", name: "Omkar's iPhone", platform: "ios", appVersion: "1.9.0", timeZone: "Asia/Kolkata", capabilities: { calendar: "full", contacts: "limited" }, ...over });
it("registers, lists online, and persists across a reload", ...)   // register("companion:d1","owner",reg()); list(null) has one PublicPhone online:true; new PhoneRegistry(file) still has it, online:false after now += 61_000
it("re-registration under a new key replaces the old record", ...) // register("session:s1","owner",reg()); register("session:s2","owner",reg()) → list has one phone with key "session:s2"
it("keeps another owner's phone with the same installId", ...)     // owner "a" and "b" both register installId → two records
it("refuses the 21st phone with 409", ...)
it("marks busy from the callback", ...)                            // list(null, () => true)[0].busy === true
it("remove drops the record and the mirror line", ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run server/phones/registry.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `server/phones/registry.ts`** as specified. `online = now() - seen < PHONE_ONLINE_MS`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run server/phones/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/phones/registry.ts server/phones/registry.test.ts
git commit -m "feat(phones): registry of paired phones and what each allows"
```

---

### Task 3: Phone job queue

**Files:**
- Create: `server/phones/jobs.ts`, `server/phones/jobs.test.ts`

**Interfaces:**
- Consumes: nothing new (same shape as `SharedComputers`, `server/shared-computers.ts:92-301`; `responseGone` is reused from there).
- Produces:
  ```ts
  export type PhoneJobCode = "denied" | "foreground_required" | "not_found" | "too_large" | "unsupported" | "offline" | "timeout" | "turn_ended";
  export type PhoneJobOutcome = { ok: true; result: unknown } | { ok: false; error: string; code?: PhoneJobCode };
  export const PHONE_JOB_CODES = ["denied", "foreground_required", "not_found", "too_large", "unsupported", "offline", "timeout", "turn_ended"] as const;
  export const phoneJobOutcome = z.union([ z.object({ ok: z.literal(true), result: z.unknown() }).strict(), z.object({ ok: z.literal(false), error: z.string().max(2000), code: z.enum(PHONE_JOB_CODES).optional() }).strict() ]);
  export const PHONE_JOB_TIMEOUT_MS = 45_000;
  export const PHONE_SEND_TIMEOUT_MS = 120_000;
  export const PHONE_POLL_MS = 20_000;
  export const PHONE_DELIVERY_MS = 10_000;
  export const PHONE_RESULT_MAX_BYTES = 262_144;
  export class PhoneJobs {
    constructor(onQueued?: (key: string, jobId: string) => void);   // the SSE nudge
    /** One job in flight per phone; a second request waits for the first to finish, up to its own timeout.
     * Two classes (spec §2): an in-turn job is bound to `active()` and times out in seconds; a `background` job (a routine's
     * check, sub-project E) has no caller waiting, is never failed by `active()`, waits `timeoutMs` (the routine's tick) and
     * is dequeued only when no in-turn job is waiting. Background jobs are reads only: the queue refuses a write tool with
     * {ok:false, code:"unsupported"}. */
    request(key: string, tool: string, args: Record<string, unknown>, options: { active: () => boolean; timeoutMs: number; offlineText: string; online: () => boolean; background?: boolean }): Promise<PhoneJobOutcome>;
    poll(key: string, gone?: AbortSignal): Promise<{ id: string; tool: string; arguments: Record<string, unknown>; expiresAt: number } | null>;
    lease(key: string, jobId: string): boolean;        // SharedComputers.liveJob
    complete(key: string, jobId: string, outcome: PhoneJobOutcome): void;   // 409 "This job expired; it will not be replayed." for unknown/unsent; result over PHONE_RESULT_MAX_BYTES → outcome {ok:false, code:"too_large"}
    busy(key: string): boolean;
    polling(key: string): boolean;     // a poll is open right now
    close(): void;                     // every waiting request gets {ok:false, code:"offline", error: "This server is restarting..."}
  }
  ```
  `request` resolves (never rejects) with `{ ok: false, code: "offline", error: offlineText }` when `online()` is false after a 15 s reconnect wait, `{ ok:false, code:"timeout", error:"<tool> did not finish on the phone within <n> seconds. It may still have run; check before repeating." }` on timeout, and `{ ok:false, code:"turn_ended", error:"The requesting turn ended" }` when `active()` turns false.

- [ ] **Step 1: Write the failing tests** `server/phones/jobs.test.ts` with `vi.useFakeTimers()` like `server/shared-computers.test.ts`:

```ts
it("delivers one job to the poll, leases it and returns the result")   // request → poll returns {id, tool:"PHONE_LIST_EVENTS"} → lease true → complete {ok:true,result:{events:[]}} → request resolved with it
it("re-delivers a job that was polled but never leased after 10 s")   // poll (no lease), advance 10_000, poll again → same tool, different id
it("answers the offline sentence when nobody polls")                  // online: () => false → resolves ok:false code:"offline" after 15 s
it("a late result is refused")                                        // complete after the turn ended / after timeout → throws status 409 and the earlier outcome stands
it("runs one job at a time per phone and nudges on queue")            // two requests; onQueued called with the first id only until it completes; poll returns the second after complete
it("truncates nothing: an oversized result becomes too_large")        // result string of 300_000 chars → ok:false code:"too_large"
it("close fails every waiting request as offline")
it("in-turn jobs go first and a background job survives its turn ending")   // background PHONE_LIST_EVENTS queued with active: () => false and timeoutMs 900_000, then an in-turn job → poll returns the in-turn job first, then the background one; advancing 45_000 fails only the in-turn one
it("a background write is refused as unsupported")                           // background PHONE_CREATE_EVENT → {ok:false, code:"unsupported"} without queuing
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run server/phones/jobs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `server/phones/jobs.ts`**, copying the `Job`/`wake`/`send`/`finish` mechanics of `SharedComputers` (poll with `polls` counter, newest poll wins, `wake` on request/re-queue/close; `DELIVERY_MS` re-key with `randomUUID()`), keyed by phone key, outcomes instead of reject.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run server/phones/jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/phones/jobs.ts server/phones/jobs.test.ts
git commit -m "feat(phones): job queue a phone long-polls, leases and answers"
```

---

### Task 4: Tool catalog, instructions, per-bot verdict

**Files:**
- Create: `server/phones/tools.ts`, `server/phones/instructions.ts`, `server/phones/access.ts`, `server/phones/access.test.ts`
- Test also: `server/phones/tools.test.ts`

**Interfaces:**
- Consumes: `compileToolSchema` / `schemaProblems` from `server/mcp-schema-validator.ts` (as `server/highlevel/tools.ts:75` uses them), `isReadOnlyAction`, `connectorScopeRefusalText` from `server/connector-verdict.ts`, `appendDecision`'s row shape.
- Produces:
  ```ts
  // tools.ts
  export const PHONE_TOOLS: ReadonlyArray<{ name: PhoneToolName; description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false } }>;
  export function phoneToolCallProblem(name: unknown, args: unknown): string | null;
  export interface PhoneToolResult { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }
  export function phoneErrorResult(message: string, extra?: Record<string, unknown>): PhoneToolResult;
  export function phoneOkResult(result: unknown, phone: { name: string; platform: PhonePlatform }): PhoneToolResult;   // text = JSON of { phone, ...result }
  // instructions.ts (no imports; bundled into the proxy)
  export const PHONE_INSTRUCTIONS: string;   // tools/list instructions: the phone is the person's own device; reads are free; writes show in chat; sends open a sheet the person taps; after an unknown outcome read back with the matching PHONE_GET_/PHONE_LIST_ before repeating
  export const PHONE_PROMPT: string;         // system-prompt part, leading space
  export const PHONE_RECOVERY: string;       // the RECOVERY sentence for the device kind
  export const PHONE_NO_PHONE_TEXT = "No phone is paired with its apps allowed. Ask the person to open MausBot on their phone and allow apps under Settings.";
  // access.ts
  export interface PhoneBot { id: string; name: string; chiefOfStaff?: boolean; phoneApps?: PhoneApps }
  export function phoneAppsFor(bot: PhoneBot): PhoneApps;   // bot.phoneApps ?? (bot.chiefOfStaff ? ALL_PHONE_APPS : {})
  export interface PhoneDecisionRow { tool: string; summary?: string; decision: "auto-approved" | "auto-denied"; rule: string }
  export type PhoneAccess = { ok: true; rows: PhoneDecisionRow[] } | { ok: false; text: string; rows: PhoneDecisionRow[] };
  /** The phone's grant decides existence; the bot's grant decides read/write. */
  export function phoneAccess(bot: PhoneBot, allowed: Readonly<Partial<Record<PhoneCapability, string>>>, name: string): PhoneAccess;
  export function phoneSystemPrompt(bot: PhoneBot, phones: ReadonlyArray<{ name: string; platform: PhonePlatform; capabilities: Partial<Record<PhoneCapability, string>> }>): string;
  ```
  Rules in `phoneAccess`, in order: unknown name → deny rule `phone:unknown`; capability not in `allowed` → deny rule `phone:<cap>:not-allowed-on-phone`, text "<bot> can't use <Cap> on this phone: it is not allowed in the MausBot app on the phone."; bot grant absent → deny rule `scope:phone:<cap>:app` using `connectorScopeRefusalText({kind:"tools", invoked:name, names:[name]}, "app", bot.name, "Phone <Cap>", humanized action)`; write with grant `read` → deny rule `scope:phone:<cap>:write`; else ok with row `{ summary: "allowed <name>", decision: "auto-approved", rule: "scope:phone:<cap>" }`.
  Schemas (spec §3 table): dates ISO 8601 strings; `phone` optional string on every tool; `PHONE_LIST_EVENTS { from, to, calendar? }`, `PHONE_GET_EVENT { id }`, `PHONE_FIND_FREE_TIME { from, to, minutes }`, `PHONE_CREATE_EVENT { title, start, end, allDay?, location?, notes?, attendees?: string[] }`, `PHONE_UPDATE_EVENT { id, ...same optional }`, `PHONE_DELETE_EVENT { id }`, `PHONE_RESPOND_TO_INVITE { id, response: "accept"|"decline"|"tentative" }`, `PHONE_LIST_REMINDERS { list?, from?, to?, completed? }`, `PHONE_CREATE_REMINDER { title, due?, notes?, list? }`, `PHONE_UPDATE_REMINDER { id, title?, due?, notes? }`, `PHONE_COMPLETE_REMINDER { id }`, `PHONE_DELETE_REMINDER { id }`, `PHONE_SEARCH_CONTACTS { query }`, `PHONE_GET_CONTACT { id }`, `PHONE_CREATE_CONTACT { givenName, familyName?, phones?: string[], emails?: string[], organization?, notes? }`, `PHONE_UPDATE_CONTACT { id, ...same optional }`, `PHONE_GET_LOCATION {}`, `PHONE_FIND_PLACES_NEARBY { query, radiusMeters? }`, `PHONE_LIST_HOME {}`, `PHONE_SET_ACCESSORY { accessoryId, characteristic, value }`, `PHONE_RUN_SCENE { sceneId }`, `PHONE_SEND_MESSAGE { to, text }`, `PHONE_SEND_WHATSAPP { to, text }`.

- [ ] **Step 1: Write the failing tests**

`server/phones/tools.test.ts`:
```ts
it("lists one schema per tool name and validates arguments", () => {
  expect(PHONE_TOOLS.map((t) => t.name)).toEqual([...PHONE_TOOL_NAMES]);
  expect(phoneToolCallProblem("PHONE_CREATE_EVENT", { title: "Lunch", start: "2026-10-24T12:00:00+05:30", end: "2026-10-24T13:00:00+05:30" })).toBeNull();
  expect(phoneToolCallProblem("PHONE_CREATE_EVENT", { title: "Lunch" })).toMatch(/start/);
  expect(phoneToolCallProblem("PHONE_SEND_MESSAGE", { to: "Rahul", text: "x", extra: 1 })).toMatch(/extra/);
  expect(phoneToolCallProblem("PHONE_NOPE", {})).toMatch(/Unknown phone tool/);
});
```
`server/phones/access.test.ts`:
```ts
const chief: PhoneBot = { id: "c", name: "Chief of Staff", chiefOfStaff: true };
const scout: PhoneBot = { id: "s", name: "Scout" };
const reader: PhoneBot = { id: "r", name: "Reader", phoneApps: { calendar: "read" } };
const onPhone = { calendar: "full", contacts: "limited" };
it("the Chief gets every app the phone allows, others nothing", () => {
  expect(phoneAccess(chief, onPhone, "PHONE_CREATE_EVENT").ok).toBe(true);
  expect(phoneAccess(scout, onPhone, "PHONE_LIST_EVENTS")).toMatchObject({ ok: false, rows: [{ rule: "scope:phone:calendar:app", decision: "auto-denied" }] });
});
it("the phone's grant decides existence", () => {
  expect(phoneAccess(chief, onPhone, "PHONE_LIST_REMINDERS")).toMatchObject({ ok: false, rows: [{ rule: "phone:reminders:not-allowed-on-phone" }] });
});
it("read grant refuses writes with the scope text", () => {
  const verdict = phoneAccess(reader, onPhone, "PHONE_CREATE_EVENT");
  expect(verdict).toMatchObject({ ok: false, rows: [{ rule: "scope:phone:calendar:write" }] });
  expect(phoneAccess(reader, onPhone, "PHONE_LIST_EVENTS").ok).toBe(true);
});
it("the prompt names the phone and its apps", () => {
  expect(phoneSystemPrompt(chief, [{ name: "Omkar's iPhone", platform: "ios", capabilities: onPhone }])).toContain("Omkar's iPhone");
  expect(phoneSystemPrompt(scout, [{ name: "Omkar's iPhone", platform: "ios", capabilities: onPhone }])).toBe("");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run server/phones/tools.test.ts server/phones/access.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the three files.** `PHONE_PROMPT` starts with a space and says: the person's phone(s) by name with the apps each allows, that reads need no permission, writes are shown in the chat, a message is only sent when the person taps Send on the phone, and that an offline phone needs the app opened.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run server/phones/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/phones/tools.ts server/phones/instructions.ts server/phones/access.ts server/phones/tools.test.ts server/phones/access.test.ts
git commit -m "feat(phones): tool catalog, instructions and the per-bot verdict"
```

---

### Task 5: Phone identity and REST routes

**Files:**
- Create: `server/routes/phones.ts`, `server/routes/phones.test.ts`
- Modify: `server/request-auth.ts:263-290` (CLIENT_ALLOW), `companion/src/routes.ts:82-215` (ALLOWED), `companion/test/routes.test.ts`

**Interfaces:**
- Consumes: `PhoneRegistry` (Task 2), `PhoneJobs` (Task 3), `responseGone` from `server/shared-computers.ts`, `RouteHandler`/`PASS` from `server/routes/table.ts`, `ownerOrAdmin` from `server/request-auth.ts`.
- Produces:
  ```ts
  /** Keyed by what authenticated the request, never by the body: a Cloud session, or the sidecar's device header. */
  export function phoneKey(req: IncomingMessage, auth: RequestAuth): string | null;   // session (not cookieOnly) → `session:${id}`; companion marker "1" + /^[\w-]{1,128}$/ device → `companion:${device}`; else null
  export interface PhoneRouteDeps {
    registry: PhoneRegistry; jobs: PhoneJobs;
    /** The owner this phone belongs to, or null when phones are not offered here (team Cloud, hosted workspace, guest session). */
    owner: (auth: RequestAuth) => string | null;
    isAdmin: (auth: RequestAuth) => boolean;
  }
  export function createPhoneRoutes(deps: PhoneRouteDeps): RouteHandler;
  ```
  Routes (all JSON, `Cache-Control: no-store`):
  - `PUT /api/phones/self` body `phoneRegistration` → 200 `{ phone: PublicPhone }` (`key` inside is what the phone filters `device.job` frames by); 400 "Invalid phone registration"; 403 when `phoneKey` or `owner` is null with "Only a paired phone can register its apps, and only for itself."; 409 from the registry.
  - `GET /api/phones/self` → 200 `{ phone: PublicPhone | null }`.
  - `DELETE /api/phones/self` → 200 `{ removed: boolean }`.
  - `GET /api/phones/self/jobs` → long poll: `jobs.poll(key, responseGone(res))`, 200 `{ job }`; marks `registry.seen(key)`; 404 "Register this phone first" when unknown.
  - `POST /api/phones/self/jobs/:id/lease` → 200 `{ active }`.
  - `POST /api/phones/self/jobs/:id/result` body `phoneJobOutcome` → 200 `{ ok: true }`; 400 on shape; 409 from jobs.
  - `GET /api/phones` (isAdmin) → 200 `{ phones: PublicPhone[] }` for `owner(auth)` (null on desktop lists all).
  - `DELETE /api/phones/:key` (isAdmin, key URL-encoded) → 200 `{ removed }`.
  Everything else under `/api/phones` → 404 `{ error: "not found" }`; outside → `PASS`.
  CLIENT_ALLOW additions: `{ methods: ["GET","PUT","DELETE"], path: /^\/api\/phones\/self$/ }`, `{ methods: ["GET"], path: /^\/api\/phones\/self\/jobs$/ }`, `{ methods: ["POST"], path: /^\/api\/phones\/self\/jobs\/[\w-]+\/(?:lease|result)$/ }`.
  Companion ALLOWED additions: the same three shapes.

- [ ] **Step 1: Write the failing tests** `server/routes/phones.test.ts`, with the `serve()` helper of `server/routes/live.test.ts:20-45` (real HTTP so the long poll's `responseGone` works) and `fromPhone()` headers:

```ts
it("a loopback request without the companion marker has no phone key")   // headers only x-openmausbot-companion-device → PUT self → 403
it("registers from the companion header and lists for the owner")        // PUT self with fromPhone("d1") → 200 phone.key "companion:d1"; GET /api/phones → one
it("a client session registers under its session id")                     // auth {kind:"session", session:{id:"s1",...}, scopes:["client"]} → key "session:s1"
it("long-polls a job, leases and answers it")                              // jobs.request in background; GET self/jobs → job; POST lease → {active:true}; POST result → request resolves
it("refuses a result for an unknown job with 409")
it("GET /api/phones needs an admin")                                       // client session → 403
it("a team Cloud offers no phones")                                        // owner: () => null → PUT self 403
```
Add to `companion/test/routes.test.ts` "what it may": `["PUT","/api/phones/self"]`, `["GET","/api/phones/self/jobs"]`, `["POST","/api/phones/self/jobs/j1/result"]` allowed; and in "what it may not": `["GET","/api/phones"]` is 404 (not listed, not explained).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run server/routes/phones.test.ts companion/test/routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `server/routes/phones.ts`** and the two allowlist edits.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run server/routes/phones.test.ts companion/test/routes.test.ts companion/test/proxy.test.ts server/request-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/phones.ts server/routes/phones.test.ts server/request-auth.ts companion/src/routes.ts companion/test/routes.test.ts
git commit -m "feat(phones): the phone's own routes: register, poll, lease, answer"
```

---

### Task 6: The `device` harness MCP kind

**Files:**
- Modify: `server/harness-mcp-request.ts:10-23,87-91`, `server/harness-mcp-token.ts`, `server/harness-mcp-proxy.ts:52`, `server/drivers/turn-mcp.ts:32,63`, `server/harness-budget.ts`
- Test: `server/harness-mcp-proxy.test.ts:27` (kind union), add one case

**Interfaces:**
- Produces: `HarnessMcpKind = "browser" | "computer" | "data" | "highlevel" | "device"`; `NAMES.device = "Phone"`; `INSTRUCTIONS.device = PHONE_INSTRUCTIONS`; `RECOVERY.device = PHONE_RECOVERY`; `harnessMcpTokenEnv("device") === "OMB_MCP_TOKEN_DEVICE"`; `export const HARNESS_PROXY_TIMEOUTS_MS: Partial<Record<HarnessMcpKind, number>> = { device: 10 * 60_000 }` in `harness-budget.ts`, used by `harnessMcpRequest` as `HARNESS_PROXY_TIMEOUTS_MS[kind] ?? HARNESS_PROXY_TIMEOUT_MS`; `turn-mcp.ts` `HARNESS_KINDS` gains `"device"` and `turnStdioMcpServers` adds `add("device", turn.integrations?.device)`.

- [ ] **Step 1: Write the failing test** in `server/harness-mcp-proxy.test.ts`:

```ts
it("forwards device calls to /api/internal/device/mcp with the phone recovery text", async () => {
  await harnessMcpRequest(frame("tools/list"), connection("device"));
  expect(requests.at(-1)?.url).toBe("/api/internal/device/mcp");
  // initialize carries the phone instructions
  await expect(harnessMcpRequest(frame("initialize"), connection("device"))).resolves.toMatchObject({ result: { instructions: expect.stringContaining("phone") } });
});
```
(extend the `connection` helper's kind union with `"device"`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/harness-mcp-proxy.test.ts`
Expected: FAIL on the kind type / 404.

- [ ] **Step 3: Implement** the edits listed under Interfaces; `parseHarnessMcpKind` accepts `"device"`; the proxy's usage text lists it.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/harness-mcp-proxy.test.ts server/drivers/turn-mcp.test.ts server/routes/own-mcp-http.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/harness-mcp-request.ts server/harness-mcp-token.ts server/harness-mcp-proxy.ts server/harness-budget.ts server/drivers/turn-mcp.ts server/harness-mcp-proxy.test.ts
git commit -m "feat(phones): device as a fifth harness MCP kind with its own timeout"
```

---

### Task 7: Engines mount the device integration

**Files:**
- Modify: `server/contracts.ts:142-176` (integrations) and `:210-225` (capabilities); `server/drivers/claude.ts:1138,2078`; `server/drivers/codex.ts:788,1832`; `server/drivers/pi.ts:123,1106`; `server/drivers/chat-mcp-tools.ts:271`; `server/drivers/openai-chat.ts:892`; `server/drivers/acp/grok.ts:429`; `server/drivers/acp/core.ts:1846`; `server/drivers/muse-code.ts:606`; `server/automatic-recovery.ts:11-12`; `server/harness/registry.ts:310-323`; `src/state/store.tsx:520-528`
- Test: `server/drivers/capability-fields.test.ts:39,47`

**Interfaces:**
- Produces: `integrations.device?: { command: string; args: string[]; env: Record<string, string> }` with the comment `/** The paired phone's app tools' MCP proxy: the harness holds the jobs and the per-bot verdict. */`; capability `deviceMcp?: boolean` ("The driver can mount the phone apps MCP."); every site that lists `"highlevel"` also lists `"device"` (the `for (const name of ["data", "highlevel"] as const)` loops become `["data", "highlevel", "device"]`); every `highlevelMcp: true` gets `deviceMcp: true`; `registry.ts` `describe()` emits `deviceMcp` (and, while there, `highlevelMcp` and `dataMcp`, which it never sent); the client capability type gains `deviceMcp?: boolean`.

- [ ] **Step 1: Write the failing test**: in `capability-fields.test.ts` add `expect(mounted.adapter.capabilities.deviceMcp).toBe(true);` next to the highlevel line and `expect(bare.adapter.capabilities.deviceMcp).toBe(false);`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/drivers/capability-fields.test.ts`
Expected: FAIL (undefined).

- [ ] **Step 3: Implement** all sites above. In `chat-mcp-tools.ts` add `if (integrations?.device && eligible("device")) servers.push(["device", integrations.device]);`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/drivers/capability-fields.test.ts server/drivers/ && pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/contracts.ts server/drivers server/automatic-recovery.ts server/harness/registry.ts src/state/store.tsx
git commit -m "feat(phones): every engine that mounts HighLevel mounts the device tools too"
```

---

### Task 8: Move the outbound hold out of index.ts (a move, no behaviour change)

**Files:**
- Create: `server/outbound-hold.ts`, `server/outbound-hold.test.ts`
- Modify: `server/index.ts:15585-15691` and `:15704-15736` (the connectors handler)

**Interfaces:**
- Consumes (as deps, per `server/host/README.md` rule 1): `store` (`appendMessage`, `bot`, `messagesFor`, `patchMessage`, `setActivity`, `setTaskActivity`, `taskByThread`), `dataDir`, `outboundRequests: OutboundRequestService`, `outboundCounts: OutboundCounts`, `holdMs`, `connectorThread(botId, threadId)`, `activeGroupTurnForBot(botId)`, `notify(notification)`, `buildNotification`.
- Produces:
  ```ts
  export interface OutboundHoldDeps { ... as above ... }
  export type OutboundHoldAnswer = { ok: true; approved: boolean } | { ok: false; text: string };
  export interface OutboundHold {
    /** Below Full access, a send waits on the "Send on your behalf?" card or spends the daily allowance. Writes the same decision rows as before. */
    hold(input: { bot: BotRecord; threadId: string; tool: string; calls: ConnectorCall[]; opaque: boolean; fullAccess: boolean; active: () => boolean }): Promise<OutboundHoldAnswer>;
    /** At dispatch time: Full access logs auto-approved; "allow" reserves against the cap; otherwise the hold must have been approved. Throws the refusal text. */
    reserve(input: { bot: BotRecord; threadId: string; tool: string; calls: ConnectorCall[]; opaque: boolean; fullAccess: boolean; approved: boolean }): void;
  }
  export function createOutboundHold(deps: OutboundHoldDeps): OutboundHold;
  ```
  The connectors handler keeps its `refuseOutbound`, `sendsFreely`, `connectorAccessDecision` and `opaque` lines and replaces the moved block with `const held = outboundTool && !fullAccess ? await outboundHold.hold({...}) : { ok: true, approved: false }; if (!held.ok) return refuseOutbound(held.text); const outboundApproved = held.approved; if (outboundApproved) requireActiveInternalCapability();`, and the dispatch-time branch with `if (outboundTool) try { outboundHold.reserve({ bot: fresh, ..., fullAccess: fullAccess && sendsFreely(), approved: outboundApproved }); } catch (e) { refuseDispatch((e as Error).message); }`. Decision rows, card contents, activity flips, notification and timeout patch are byte-identical moves. The two late `requireActiveInternalCapability()` / `internalCapabilityIsActive` checks stay in the handler (passed as `active`).

- [ ] **Step 1: Write the failing test** `server/outbound-hold.test.ts` with an in-memory fake store (record `appendMessage` calls; `bot()` returns the bot; `taskByThread` returns `{ busy: true }`), a real `OutboundRequestService`, `OutboundCounts` on a tmp file, `holdMs: 1_000`:

```ts
it("allow policy under the cap approves without a card and records the row")   // bot.outbound {policy:"allow",dailyCap:2} → hold ok approved:false; reserve twice ok; third throws /daily outbound limit/
it("ask policy posts the card and resolves on allow")                             // hold pending; store has an options card with title "Send on your behalf?" and requestId; outboundRequests.resolve({threadId, requestId, behavior:"allow"}) → {ok:true, approved:true}
it("deny answers the decline text; timeout marks the card unavailable")          // resolve deny → text matches /the user declined/; fake timers to 1_000 → text matches /nobody answered/ and the card patched answered:"unavailable"
it("reserve refuses when the hold was not approved and the policy is ask")       // reserve({approved:false, fullAccess:false}) throws /outbound policy changed/
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/outbound-hold.test.ts`
Expected: FAIL.

- [ ] **Step 3: Move the code** from `index.ts` into `createOutboundHold`, construct it in `index.ts` on the same line as `outboundRequests`/`outboundCounts` (`:9698-9700`), and rewrite the handler as described. Review with `git diff --color-moved=dimmed-zebra`.

- [ ] **Step 4: Run the moved behaviour's tests**

Run: `pnpm vitest run server/outbound-hold.test.ts server/index.test.ts -t "outbound" && pnpm vitest run server/connectors.e2e.test.ts server/outbound-requests.test.ts && wc -l server/index.ts`
Expected: PASS; `server/index.ts` at least 90 lines shorter than 16924 (write the number down for Task 15).

- [ ] **Step 5: Commit**

```bash
git add server/outbound-hold.ts server/outbound-hold.test.ts server/index.ts
git commit -m "refactor(outbound): move the send hold out of index.ts so other tool kinds can use it"
```

---

### Task 9: Phone MCP host (rpc + host)

**Files:**
- Create: `server/phones/rpc.ts`, `server/phones/host.ts`, `server/phones/rpc.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 4, 8; `appendDecision` from `server/decision-log.ts`; `SPAWNED_PROXIES.harnessMcp`, `AGENTS_NODE_FLAG` from `server/proxy-paths.ts`; `harnessMcpTokenEnv`; `outboundCallsIn` from `shared/outbound.ts`.
- Produces:
  ```ts
  // rpc.ts
  export const PHONE_INTERNAL_MCP_PATH = "/api/internal/device/mcp";
  export interface PhoneRpcDeps {
    assertActive(): void;
    authorize(name: string): { ok: true } | { ok: false; text: string };
    /** Which phone runs it, or null when none is paired with its apps allowed. */
    phone(preferred?: string): { key: string; name: string; platform: PhonePlatform } | null;
    /** A send waits on the hold first; refusal text comes back to the bot. */
    holdSend(name: string, args: Record<string, unknown>): Promise<{ ok: true } | { ok: false; text: string }>;
    run(phone: { key: string; name: string; platform: PhonePlatform }, name: PhoneToolName, args: Record<string, unknown>): Promise<PhoneJobOutcome>;
    onWrite?(record: { tool: PhoneToolName; phone: string; summary: string }): void;
  }
  export type PhoneToolsList = { tools: typeof PHONE_TOOLS[number][]; instructions: string };
  export async function phoneRpc(request: { method?: unknown; params?: unknown } | null | undefined, deps: PhoneRpcDeps): Promise<PhoneToolsList | PhoneToolResult>;
  // host.ts
  export interface PhoneHostDeps {
    registry: PhoneRegistry; jobs: PhoneJobs; dataDir: string;
    bot(id: string): (PhoneBot & { color?: string; outbound?: OutboundPolicy }) | undefined | null;
    /** The owner whose phones a turn may use, or null when the turn is not provably the owner's (spec §2 "Whose phone"). */
    turnOwner(capability: { botId: string; threadId: string; generation: string }): string | null;
    inRoom(threadId: string): boolean;
    appendMessage(threadId: string, message: Record<string, unknown>): void;
    outboundHold: OutboundHold;
    sendsFreely(capability: { botId: string; threadId: string }): boolean;
    active(capability: { botId: string; threadId: string; generation: string }): boolean;
  }
  export interface PhoneHost {
    mounts(bot: PhoneBot, owner: string | null): boolean;      // owner has ≥1 phone with ≥1 allowed capability the bot may use
    integration(bot: PhoneBot, owner: string | null, mint: () => string, harnessUrl: string): { command: string; args: string[]; env: Record<string, string> } | null;
    prompt(bot: PhoneBot, owner: string | null): string;
    handle(body: unknown, capability: { botId: string; threadId: string; generation: string }, assertActive: () => void): Promise<PhoneToolsList | PhoneToolResult>;
    toolListing(): { phone: Array<{ name: string; description: string }> } | null;   // null when no phone is registered
  }
  export function createPhoneHost(deps: PhoneHostDeps): PhoneHost;
  ```
  `phoneRpc` order on `tools/call`: validate (`phoneToolCallProblem`) → `assertActive` → `authorize` → `phone(args.phone)` (null → `phoneErrorResult(PHONE_NO_PHONE_TEXT, { code: "no_phone" })`) → if `phoneToolSends(name)`: `holdSend` (refusal → error result `code: "refused"`) → `run` with `timeoutMs` = `PHONE_SEND_TIMEOUT_MS` for sends else `PHONE_JOB_TIMEOUT_MS` → `assertActive` → outcome: ok → `phoneOkResult(result, phone)` and `onWrite` for writes; not ok → `phoneErrorResult(error, { code })`. `tools/list` filters `PHONE_TOOLS` by `authorize(name).ok`.
  `host.handle`'s `authorize` resolves the owner with `turnOwner(capability)` (null → every tool denied with rule `phone:not-owner`, text "This conversation can't use a phone: only the owner's own turns can."), merges the owner's phones' capabilities for the existence check, writes decision rows (`source: "connector-scope"`) like `server/highlevel/host.ts:144-152`. `holdSend` calls `outboundHold.hold({ bot, threadId, tool: name, calls: outboundCallsIn(name, args), opaque: false, fullAccess: sendsFreely(capability), active })` then `outboundHold.reserve({...approved})` inside a try, returning the thrown text as a refusal. `onWrite` appends an activity row `{ role: "bot", kind: "activity", tool: { name: `mcp__device__${tool}`, ok: true, summary }, from? }` where `summary` is `"<humanized action> on <phone name>"` cut at 240.

- [ ] **Step 1: Write the failing tests** `server/phones/rpc.test.ts` (fake deps, real `PhoneJobs` with a scripted poller that leases and answers):

```ts
it("tools/list shows what the bot may run on the paired phone")        // chief + phone {calendar:"full"} → names all start PHONE_ and are calendar tools only
it("a read runs on the phone and the result names the phone")          // PHONE_LIST_EVENTS → poller answers {events:[]} → content text contains "Omkar's iPhone" and "events"
it("a write records an activity row")
it("a send waits on the hold and a refusal reaches the bot")           // holdSend → {ok:false,text:"declined"} → isError, text "declined", run never called
it("grant lowered during the hold refuses the send")                   // holdSend resolves ok but authorize (re-read live bot) now denies → isError with the scope text; run never called  [host test: bot() returns phoneApps {messages:"read"} on the second read]
it("no phone paired answers the no-phone sentence")
it("a turn that is not the owner's sees no tools")                     // turnOwner → null → tools/list empty, tools/call refused rule phone:not-owner
it("an offline phone answers the offline sentence with the phone's name")
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run server/phones/rpc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `rpc.ts` and `host.ts`.** `integration()` mirrors `server/highlevel/host.ts:132-139` with `[SPAWNED_PROXIES.harnessMcp, PHONE_MCP_SERVER]` and `harnessMcpTokenEnv("device")`. The offline text is `${phone.name} is offline. Open the MausBot app on it.`

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run server/phones/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/phones/rpc.ts server/phones/host.ts server/phones/rpc.test.ts
git commit -m "feat(phones): MCP host that turns a bot's call into a phone job behind the per-bot verdict and the send hold"
```

---

### Task 10: Wire it into index.ts (net zero lines)

**Files:**
- Modify: `server/index.ts` at: imports (join onto `:101-104`), `:694` (instances), `:1744` (kind union), `:2634` (after `highlevelIntegration`), `:3054-3055` (host construction), `:3200` / `:8908` / `:10740` (prompt parts), `:8841` / `:10527` (mounts), `:13224` (ROUTES.push), `:13788` (maintenance exemption), `:13946` (testing kind enum), `:14000` (route family), `:14234-14236` (handler), `:16316-16321` (tools picker), `:16861` (shutdown)
- Test: `server/phones.e2e.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 5, 8, 9; `cloudLendingRefusal`, `cloudLendingTurn`, `cloudHomeLendingRefusal` (`server/cloud-lending.ts:31`), `CLOUD_OWNER_KEY`, `cloudOwnerSession`, `HOSTED_WORKSPACE`, `CLOUD_TEAM`, `broadcast`, `personKey`.
- Produces (all on existing lines):
  - `const phoneRegistry = new PhoneRegistry(join(DATA_DIR, "phones.json")); const phoneJobs = new PhoneJobs((phone, id) => broadcast({ kind: "device.job", phone, id }, { adminOnly: true }));` appended to `:694`.
  - `InternalCapability.kind` union gains `| "device"`; testing enum gains `"device"`.
  - `const DESKTOP_OWNER = "owner";` and `function phoneOwnerOf(auth: RequestAuth): string | null { return HOSTED_WORKSPACE || CLOUD_TEAM ? null : CLOUD_HOME ? (cloudOwnerSession(auth) ? CLOUD_OWNER_KEY : null) : DESKTOP_OWNER; }` placed on the `CLOUD_HOME_LENDER` line.
  - `function phoneTurnOwner(c: Pick<InternalCapability, "botId" | "threadId" | "generation">): string | null { if (HOSTED_WORKSPACE || CLOUD_TEAM) return null; if (CLOUD_HOME) return cloudLendingRefusal(c) === null ? CLOUD_OWNER_KEY : null; const turn = cloudLendingTurn(c); return cloudHomeLendingRefusal({ ...turn, ownerPerson: (p) => p === undefined, routineRun: () => { const run = turn.routineRun(); return run && { ...run, ownerStarted: true, ownerAuthored: true }; } }) === null ? DESKTOP_OWNER : null; }` on the line after `cloudLendingRefusal` (join with its closing brace line). Off-Cloud, user lines carry no `sender` (`index.ts:422` sets it only on a Cloud home), so "no person" is the owner; routines are the owner's; webhooks stay refused by the helper.
  - `const phoneHost = createPhoneHost({ registry: phoneRegistry, jobs: phoneJobs, dataDir: DATA_DIR, bot: (id) => store.bot(id), turnOwner: phoneTurnOwner, inRoom: (t) => Boolean(store.groupByThread(t)), appendMessage: (t, m) => { store.appendMessage(t, m as Parameters<typeof store.appendMessage>[1]); }, outboundHold, sendsFreely: (c) => roomTurnLevels.forRequest(c.threadId, c.botId, () => sourceApprovalMode(c.botId, c.threadId)) === "full", active: (c) => internalCapabilityIsActive(c as InternalCapability) });` on the `highlevelHost` line.
  - `function deviceIntegration(bot: BotRecord, turn: {...}) { return phoneHost.integration(bot, phoneTurnOwner({ botId: bot.id, ...turn }), () => mintInternalCapability({ botId: bot.id, ...turn, kind: "device", depth: 0, skillAuthoring: false, createdBots: 0, openedThreads: 0 }), `http://127.0.0.1:${PORT}`); }` on the `highlevelIntegration` line.
  - Mount sites: append `if (liveBot && instance.adapter.capabilities.deviceMcp === true) { const phone = deviceIntegration(liveBot, { threadId, generation: dispatchClaimId }); if (phone) integrations.device = phone; }` to `:8841`; the room twin to `:10527` with `readyBot` / `internalGeneration`.
  - Prompt parts: `{ id: "device", label: "Phone", text: integrations.device ? phoneHost.prompt(liveBot ?? bot, phoneTurnOwner({ botId: bot.id, threadId, generation: dispatchClaimId })) : "" },` appended to the highlevel part lines at `:8908` and `:10740`; preview at `:3200` uses `caps?.deviceMcp === true && phoneHost.mounts(bot, CLOUD_HOME ? CLOUD_OWNER_KEY : DESKTOP_OWNER)`.
  - Route family: `: path === PHONE_INTERNAL_MCP_PATH ? "device"` appended to the highlevel line at `:14000`.
  - Handler: `if (method === "POST" && path === PHONE_INTERNAL_MCP_PATH) { return json(res, 200, { result: await phoneHost.handle(await readInternalBody(), internalCapability, requireActiveInternalCapability) }); }` joined onto the HighLevel handler's closing line.
  - `ROUTES.push(createPhoneRoutes({ registry: phoneRegistry, jobs: phoneJobs, owner: phoneOwnerOf, isAdmin: ownerOrAdmin }));` appended to `:13224`.
  - Maintenance exemption `:13788`: replace `!path.startsWith("/api/shared-computers/")` with `!isLongPollPath(path)` where `export function isLongPollPath(path: string): boolean { return path.startsWith("/api/shared-computers/") || path === "/api/phones/self/jobs"; }` lives in `server/routes/phones.ts` (lowers the ratchet's `path.startsWith(` count to 6: update `scripts/testing/index-route-ratchet.test.ts`).
  - Tools picker `:16316`: `const highlevelTools = { ...highlevelHost.toolListing(), ...phoneHost.toolListing() };` (so `/api/connectors/tools` lists `phone` tools when a phone is registered).
  - Shutdown `:16861`: append `phoneJobs.close();`.
  - `server/activity.ts:117`: add `if (server === "device") return { app: "Phone", label: humanize(action.replace(/^PHONE_/, "")) };`; `shared/today-outcomes.ts:55`: add `"device"` to `OWN_SERVERS`.

- [ ] **Step 1: Write the failing e2e test** `server/phones.e2e.test.ts` with `launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" })` (see `server/shared-computers.e2e.test.ts`) and the `POST /api/testing/internal-capability` route to mint a `device` capability:

```ts
it("a registered phone's tools reach the bot and a job round-trips")
  // PUT /api/phones/self with companion headers → 200
  // mint capability {kind:"device"} for the Chief's thread → POST /api/internal/device/mcp tools/list → names include PHONE_LIST_EVENTS
  // tools/call PHONE_LIST_EVENTS (in background) → GET /api/phones/self/jobs → job → lease → result {ok:true,result:{events:[]}} → call answers with the phone's name
  // SSE /api/events received {kind:"device.job", phone:"companion:...", id}
it("a bot without a grant sees no phone tools")   // a non-Chief bot → tools/list []
it("a confined run has no device integration")   // use the read-and-draft fixture of server/read-and-draft.e2e.test.ts (or proactive.e2e) : a routine run's tools/call to /api/internal/device/mcp → 403 READ_AND_DRAFT_REFUSAL
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/phones.e2e.test.ts`
Expected: FAIL (404 on the internal path / unknown kind).

- [ ] **Step 3: Make the index.ts edits** exactly as listed, each on an existing line.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run server/phones.e2e.test.ts scripts/testing/file-size-ratchet.test.ts scripts/testing/index-route-ratchet.test.ts server/read-and-draft.test.ts && pnpm typecheck && wc -l server/index.ts`
Expected: PASS; `server/index.ts` no longer than after Task 8.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts server/phones.e2e.test.ts server/activity.ts shared/today-outcomes.ts scripts/testing/index-route-ratchet.test.ts
git commit -m "feat(phones): mount the device tools per turn, route the internal MCP, nudge the phone over SSE"
```

---

### Task 11: `phoneApps` on the bot patch route

**Files:**
- Modify: `server/routes/bot-patch.ts:223-271` (validation) and `:572-614` (loosening guard); `server/store.ts` only if `BotWirePrivateKeys` needs no change (it does not: the field is on `WireBot`).
- Test: `server/routes/bot-patch.test.ts` (existing file; add cases)

**Interfaces:**
- Produces: `PATCH /api/bots/:id` accepts `phoneApps: PhoneApps | null` (null clears to the default); 400 `phoneApps must be { <calendar|reminders|contacts|location|home|messages>: read | write } or null`; a patch that adds a capability or raises read→write counts as `loosened.push("phoneApps")`.

- [ ] **Step 1: Write the failing tests** (same harness as the file's `connectorScopes` cases):

```ts
it("stores phoneApps and clears it with null")
it("rejects an unknown capability or grant")
it("treats a raised phone grant as loosening")   // existing {calendar:"read"} → {calendar:"write"} from a bare loopback while a bot is busy → 409 like connectorScopes
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run server/routes/bot-patch.test.ts -t phoneApps`
Expected: FAIL.

- [ ] **Step 3: Implement** with `normalizePhoneApps` next to the `connectorScopes` block.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run server/routes/bot-patch.test.ts server/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/bot-patch.ts server/routes/bot-patch.test.ts
git commit -m "feat(phones): per-bot phoneApps grant on the bot patch route"
```

---

### Task 12: Desktop: per-bot "Phone apps" card

**Files:**
- Modify: `src/state/store.tsx:331-334` (Bot type), `src/state/bot-patch-queue.ts:43-62`, `src/components/bot-settings/AccessSection.tsx:661,663` (`AccessPart` gains `"phone"`; render after the apps card), `src/components/bot-settings/useBotSettingsDerived.ts:47-53`
- Create: `src/components/bot-settings/PhoneAppsCard.tsx`, `src/components/bot-settings/PhoneAppsCard.test.tsx`, `src/lib/phones.ts`
- Modify: `src/locales/en.json` (keys below)

**Interfaces:**
- Produces:
  ```ts
  // src/lib/phones.ts
  export interface PublicPhone { key: string; registration: { installId; name; platform: "ios"|"android"; appVersion; timeZone; capabilities: Partial<Record<PhoneCapability, string>> }; registeredAt: number; seen: number; lastUsedAt: number | null; online: boolean; busy: boolean }
  export function usePhones(): { phase: "loading" | "ready"; phones: PublicPhone[]; refresh(): void }   // GET /api/phones every 15 s while mounted (same polling style as useSidebarPhoneStatus)
  export function effectivePhoneApps(bot: { chiefOfStaff?: boolean; phoneApps?: PhoneApps }): PhoneApps;   // mirrors server phoneAppsFor
  // PhoneAppsCard.tsx
  export function PhoneAppsCard({ bot, patch }: { bot: Bot; patch: (p: BotPatch) => void }): JSX.Element | null;   // null when no phone is registered
  ```
  The card: title `botAccess.phone.title` ("Phone apps"), subtitle naming the phone(s) and `botAccess.phone.subtitle`, six rows in spec order with Off / Read / Read & write segmented buttons (reuse the button markup of `ConnectorScopesControl`, `AccessSection.tsx:912`), a row greyed with `botAccess.phone.notOnPhone` when the phone does not allow that app, a "Default" note (`botAccess.phone.default`) when `bot.phoneApps` is undefined. Changing a row patches `{ phoneApps: { ...effectivePhoneApps(bot), [cap]: value } }` (dropping the key for Off).
  Locale keys (en.json only; other packs come from `node scripts/generate-locale.mjs <lang>` later, not in this task): `botAccess.phone.title`, `botAccess.phone.subtitle` ("What this bot may do on {phone}"), `botAccess.phone.notOnPhone` ("Not allowed on the phone"), `botAccess.phone.default` ("Using the default: the Chief gets everything the phone allows, other bots nothing."), `botAccess.phone.cap.calendar` … `botAccess.phone.cap.messages` ("Calendar", "Reminders", "Contacts", "Location", "Home", "Messages").

- [ ] **Step 1: Write the failing test** `PhoneAppsCard.test.tsx` (React Testing Library as the sibling tests do, mocking `usePhones`):

```ts
it("renders nothing without a phone")
it("shows six rows and patches a raised grant")          // click "Read & write" on Calendar → patch({ phoneApps: { ...defaults, calendar: "write" } })
it("greys an app the phone does not allow")
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/components/bot-settings/PhoneAppsCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the files and the type edits (`Bot.phoneApps?: PhoneApps`, `BotUpdatePatch.phoneApps?: Bot["phoneApps"] | null`, null→undefined in the normalizer at `bot-patch-queue.ts:114-123`).

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/components/bot-settings/ src/locales/ && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/phones.ts src/components/bot-settings/PhoneAppsCard.tsx src/components/bot-settings/PhoneAppsCard.test.tsx src/components/bot-settings/AccessSection.tsx src/components/bot-settings/useBotSettingsDerived.ts src/state/store.tsx src/state/bot-patch-queue.ts src/locales/en.json
git commit -m "feat(phones): per-bot Phone apps card in bot settings"
```

---

### Task 13: Desktop: phones in Settings → Phone

**Files:**
- Modify: `src/components/CompanionSection.tsx:238-290` (after the paired-devices list)
- Create: `src/components/PhonesList.tsx`, `src/components/PhonesList.test.tsx`
- Modify: `src/locales/en.json`

**Interfaces:**
- Consumes: `usePhones` (Task 12).
- Produces: `export function PhonesList(): JSX.Element | null` rendering, under the heading `remote.phones.title` ("Phone apps"), one row per registered phone: name, platform, online/offline (`remote.phones.online` / `remote.phones.offline` with relative `seen`), the allowed apps as chips, and a Remove button (`DELETE /api/phones/:key`, `remote.phones.remove`). Empty: `remote.phones.empty` ("No phone has allowed its apps yet. Open MausBot on your phone and allow them under Settings."). The companion section renders `<PhonesList />` below the devices list.

- [ ] **Step 1: Write the failing test** `PhonesList.test.tsx`: renders the empty line; renders one phone with "Calendar, Contacts" chips and "Online"; Remove calls `DELETE /api/phones/companion%3Ad1`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/components/PhonesList.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/components/PhonesList.test.tsx src/components/CompanionSection.test.tsx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/PhonesList.tsx src/components/PhonesList.test.tsx src/components/CompanionSection.tsx src/locales/en.json
git commit -m "feat(phones): list registered phones and their allowed apps in Settings"
```

---

### Task 14: Phone-side contract fixture

**Files:**
- Create: `server/testing/fixtures/phone-jobs.json` and `server/phones/fixture.test.ts`

**Interfaces:**
- Produces: one JSON file the phone packs (B and C) parse in their own tests: `{ registration: PhoneRegistration, registerResponse: { phone: PublicPhone }, frames: [{ kind: "device.job", phone, id }], jobs: [{ id, tool, arguments, expiresAt }], outcomes: [ {ok:true,result:{...}}, {ok:false,error,code:"foreground_required"} ], toolsList: { tools: [...PHONE_TOOLS names+schemas] } }`. The test asserts every field parses with the server's zod schemas and that `toolsList` equals `PHONE_TOOLS`, so the file cannot drift. The mausbot-mobile repo copies it into `ios/Tests/CompanionCoreTests/Fixtures/` with `scripts/capture-companion-fixtures.mjs` (already the pattern for the companion fixtures).

- [ ] **Step 1: Write the failing test**, **Step 2: run (FAIL: file missing)**, **Step 3: write the fixture**, **Step 4: run (PASS)**, **Step 5: commit** `feat(phones): phone-side contract fixture`.

---

### Task 15: Ratchets, docs, whole-suite run

**Files:**
- Modify: `scripts/testing/file-size-ratchet.test.ts:18` (lower `server/index.ts` to its new count), `docs/ios-companion.md` (one paragraph: phone apps routes and the `device.job` frame), `server/routes/README.md` (no change unless a rule was bent)

- [ ] **Step 1: Lower the pin** to the output of `wc -l server/index.ts`.
- [ ] **Step 2: Run the full gates**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: all green except failures that also fail on the base commit `30b62aaf1` (list them in the commit message; known on Omkar's Mac: cloud-sync disk, headless-cli SQLite warning, UI e2e suites).

- [ ] **Step 3: Commit**

```bash
git add scripts/testing/file-size-ratchet.test.ts docs/ios-companion.md
git commit -m "chore(phones): lower the index.ts ratchet and document the phone routes"
```

---

## Follow-ups owed to later sub-projects (not in this plan)

- B/C: the phone packs; they consume Task 14's fixture and the `/api/phones/self/*` routes.
- D: silent push nudge (the SSE frame is the only wake-up here).
- E: `phonecalendar` read app and the `messages` check; note that read-and-draft runs strip `integrations.device` (Task 10 test 3), so the reminders hand-off needs the fence widened to reads in E, not here.
- Pending Omkar: whether the proactive bot stays the Chief (this plan's default) or #3287 is revived.
