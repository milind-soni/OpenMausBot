import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { itemKey } from "../electron/cloud-send-parts.mjs";
import { CalendarCallManager } from "./calendar-calls.ts";
import { importedSkillHash, kindRecord, moveItems, moveKindsRoute, type MoveKindsDeps } from "./cloud-send-kinds.ts";
import { exportImportedSkill, IMPORTED_SKILLS_DIR, readImportedSkills, storeImportedSkills } from "./imported-skills.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import { installLibrarySkill, readSkillLibraryIndex } from "./skill-library.ts";
import { WebhookManager } from "./webhooks.ts";

const HERE = "/Users/amit/.openmausbot";
const OWNER = { person: "p_owner0000000000000000", name: "Amit" };

/** Routines held in memory as the routine manager holds them, adopting the way it does. */
function routinesHeld(routines: Routine[] = [], runs: RoutineRun[] = []) {
  return {
    routines, runs,
    listRoutines: () => routines.map((routine) => structuredClone(routine)),
    listRuns: () => runs.map((run) => structuredClone(run)),
    adopt(apply: (held: { routines: Routine[]; runs: RoutineRun[] }) => Routine[]) { apply({ routines, runs }); },
  };
}
const routine = (fields: Partial<Routine> = {}): Routine => ({ id: "r1", name: "Morning", prompt: `Read ${HERE}/workspaces/b1/notes.md`, target: "bot", botId: "b1", runOn: "maus", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1] } as never, durationMinutes: 15, attachments: [{ id: "a1", kind: "file", name: "plan.md", path: `${HERE}/attachments/plan.md`, size: 4 }] as never,
  nextRunAt: 123, createdAt: 1, updatedAt: 2, ...fields });
const run = (id: string, status: string, fields: Partial<RoutineRun> = {}): RoutineRun => ({ id, routineId: "r1", routineName: "Morning", target: "bot", botId: "b1", runOn: "maus",
  scheduledFor: 10, status: status as never, manual: false, createdAt: 10, output: `Wrote ${HERE}/workspaces/b1/out.md`, ...fields });

function deps(dataDir: string, over: Partial<MoveKindsDeps> = {}): MoveKindsDeps & { owned: Array<[string, string]>; patched: Array<[string, unknown]>; chief: string[] } {
  const bots = new Map<string, Record<string, unknown>>([["b1", { id: "b1", projects: [{ id: "p-cloud", name: "Mine" }] }]]);
  const owned: Array<[string, string]> = [], patched: Array<[string, unknown]> = [], chief: string[] = [];
  return {
    dataDir, owned, patched, chief,
    store: { bots: [...bots.values()] as never, bot: (id: string) => bots.get(id) as never, group: () => undefined,
      patchBot: (id: string, patch: object) => { patched.push([id, patch]); Object.assign(bots.get(id)!, patch); return bots.get(id) as never; },
      setChiefOfStaff: (id: string | null) => { chief.push(String(id)); return []; } } as never,
    routines: () => null, calls: () => null, webhooks: () => null, appEvents: () => null, claudeCodeSkills: () => [],
    instanceExists: (id) => id === "claude", owner: () => OWNER, ownRoutine: (r, person) => owned.push([r.id, person]),
    ...over,
  };
}

async function ask(d: MoveKindsDeps, method: string, query: string, body?: unknown) {
  let answered: { status: number; body: any } | undefined;
  await moveKindsRoute(d, { path: "/api/cloud-send/kind", method, url: new URL(`http://127.0.0.1/api/cloud-send/kind${query}`), auth: {} as never, req: {} as never,
    res: { setHeader() {} } as never, json: ((_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }) as never, readBody: (async () => body) as never });
  return answered!;
}
const take = (d: MoveKindsDeps, key: string, record: unknown, runs?: unknown[]) => ask(d, "PUT", "", { v: 1, key, dataDir: HERE, record, ...(runs ? { runs } : {}) });

describe("what a move compares", () => {
  it("hashes a definition the same on both servers once each names its own data folder, apart from its switch and next time", () => {
    const here = routinesHeld([routine()], [run("run-1", "completed")]);
    const [mine] = moveItems(deps(HERE, { routines: () => here }), new Set(["b1"])).filter((item) => item.kind === "routine");
    const cloud = "/data/.openmausbot";
    const moved = routine({ prompt: `Read ${cloud}/workspaces/b1/notes.md`, attachments: [{ id: "a1", kind: "file", name: "plan.md", path: `${cloud}/attachments/plan.md`, size: 4 }] as never,
      enabled: false, nextRunAt: null, updatedAt: 99 });
    const [theirs] = moveItems(deps(cloud, { routines: () => routinesHeld([moved], [run("run-1", "completed", { output: `Wrote ${cloud}/workspaces/b1/out.md` })]) }), new Set(["b1"]));
    expect(theirs).toEqual(mine);
    expect(mine).toMatchObject({ key: itemKey.moved("routine", "r1"), kind: "routine", bot: "b1" });
    const edited = moveItems(deps(HERE, { routines: () => routinesHeld([routine({ prompt: "Something else" })], [run("run-1", "completed")]) }), new Set(["b1"]))[0]!;
    expect(edited.parts.def).not.toBe(mine!.parts.def);
    const ranAgain = moveItems(deps(HERE, { routines: () => routinesHeld([routine()], [run("run-1", "completed"), run("run-2", "failed")]) }), new Set(["b1"]))[0]!;
    expect([ranAgain.parts.def, ranAgain.parts.runs === mine!.parts.runs]).toEqual([mine!.parts.def, false]);
  });

  it("tells the move whether a routine is on here, for the switch that turns it on there", () => {
    const record = (enabled: boolean) => kindRecord(deps(HERE, { routines: () => routinesHeld([routine({ enabled })]) }), "routine", "r1")!.record as { enabled?: boolean };
    expect([record(true).enabled, record(false).enabled]).toEqual([true, false]);
  });

  it("carries automations only of the bots a move carries", () => {
    const items = moveItems(deps(HERE, { routines: () => routinesHeld([routine(), routine({ id: "r2", botId: "starter" })]) }), new Set(["b1"]));
    expect(items.map((item) => item.key)).toEqual([itemKey.moved("routine", "r1")]);
  });
});

describe("My Cloud takes a routine", () => {
  it("under its own id, switched off, with its finished runs, this computer's folder named as its own, and as its owner's", async () => {
    const cloud = mkdtempSync(join(tmpdir(), "omb-kinds-"));
    const held = routinesHeld();
    const d = deps(cloud, { routines: () => held });
    const runs = [run("run-1", "completed"), run("run-2", "running"), run("run-3", "failed", { routineId: "r9" })];
    expect((await take(d, itemKey.moved("routine", "r1"), { ...routine() }, runs)).status).toBe(200);
    expect(held.routines).toEqual([expect.objectContaining({ id: "r1", enabled: false, nextRunAt: null, prompt: `Read ${join(cloud, "workspaces", "b1", "notes.md")}` })]);
    expect((held.routines[0]!.attachments as Array<{ path: string }>)[0]!.path).toBe(join(cloud, "attachments", "plan.md"));
    expect(held.runs.map((entry) => [entry.id, entry.output])).toEqual([["run-1", `Wrote ${join(cloud, "workspaces", "b1", "out.md")}`]]);
    expect(d.owned).toEqual([["r1", OWNER.person]]);

    held.routines[0]!.enabled = true;
    held.routines[0]!.nextRunAt = 555;
    expect((await take(d, itemKey.moved("routine", "r1"), { ...routine({ name: "Morning, earlier" }) }, runs)).status).toBe(200);
    expect(held.routines).toEqual([expect.objectContaining({ id: "r1", name: "Morning, earlier", enabled: true, nextRunAt: 555 })]);
    expect(held.runs, "a run it has is never added twice").toHaveLength(1);
  });

  it("only from its owner, only once its bot is there", async () => {
    const held = routinesHeld();
    expect((await take(deps("/data", { routines: () => held, owner: () => null }), itemKey.moved("routine", "r1"), routine())).status).toBe(403);
    expect((await take(deps("/data", { routines: () => held }), itemKey.moved("routine", "r1"), routine({ botId: "gone" }))).status).toBe(409);
    expect(held.routines).toEqual([]);
  });
});

describe("My Cloud takes an app event", () => {
  const appEvents = (service: { available: true } | { available: false; reason: "self-hosted" | "unavailable" }) => {
    const adopted: string[] = [];
    return { adopted, list: () => [], remove: async () => false, service: () => service,
      adopt: async (record: { id: string }) => { adopted.push(record.id); return record as never; } };
  };
  const event = { id: "t1", botId: "b1", name: "Reply to email", prompt: "Draft a reply.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", config: {}, enabled: true };

  it("refuses it for good while connected apps are not set up there, so the move goes on without it", async () => {
    for (const reason of ["unavailable", "self-hosted"] as const) {
      const there = appEvents({ available: false, reason });
      const answer = await take(deps(HERE, { appEvents: () => there as never }), itemKey.moved("app-event", "t1"), event);
      expect(answer).toMatchObject({ status: 409, body: { final: true } });
      expect(answer.body.error).toMatch(/stays on the computer it came from/u);
      expect(there.adopted).toEqual([]);
    }
  });

  it("takes it where connected apps are set up, and a refusal that may pass is not final", async () => {
    const there = appEvents({ available: true });
    expect((await take(deps(HERE, { appEvents: () => there as never }), itemKey.moved("app-event", "t1"), event)).status).toBe(200);
    expect(there.adopted).toEqual(["t1"]);
    const notYet = await take(deps(HERE), itemKey.moved("app-event", "t1"), event);
    expect(notYet.status).toBe(503);
    expect(notYet.body.final).toBeUndefined();
  });
});

describe("My Cloud takes a webhook and a call", () => {
  it("a webhook gets an address and a secret of its own there and starts off; taken again, it keeps them and its switch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-kinds-"));
    const here = new WebhookManager({ file: join(dir, "here.json"), botState: () => "ready", enqueue: () => ({ runId: "x" }) } as never);
    const there = new WebhookManager({ file: join(dir, "there.json"), botState: () => "ready", enqueue: () => ({ runId: "x" }) } as never);
    const made = here.create({ name: "Orders", prompt: "File it.", botId: "b1" });
    const d = deps(dir, { webhooks: () => there });
    expect((await take(d, itemKey.moved("webhook", made.webhook.id), made.webhook)).status).toBe(200);
    const arrived = there.list()[0]!;
    expect(arrived).toMatchObject({ id: made.webhook.id, name: "Orders", enabled: false });
    expect(arrived.endpointId).not.toBe(made.webhook.endpointId);
    const secret = there.currentSecret(arrived.id, false)!.secret!;
    expect(secret).toMatch(/^whsec_/u);
    expect(secret).not.toBe(made.secret);
    there.update(arrived.id, { enabled: true });
    expect((await take(d, itemKey.moved("webhook", made.webhook.id), { ...made.webhook, prompt: "File it twice." })).status).toBe(200);
    expect(there.list()[0]).toMatchObject({ endpointId: arrived.endpointId, enabled: true, prompt: "File it twice." });
    expect(there.currentSecret(arrived.id, false)!.secret).toBe(secret);
  });

  it("a scheduled call starts unscheduled until it is switched on there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-kinds-"));
    const calls = new CalendarCallManager({ file: join(dir, "calls.json"), botExists: (id) => id === "b1" });
    const call = { id: "c1", name: "Sync", description: "", botIds: ["b1"], schedule: { type: "daily" as const, time: "10:00", weekdays: [1] }, durationMinutes: 30,
      attachments: [], nextRunAt: 999, createdAt: 1, updatedAt: 2 };
    expect((await take(deps(dir, { calls: () => calls }), itemKey.moved("call", "c1"), call)).status).toBe(200);
    expect(calls.get("c1")).toMatchObject({ id: "c1", nextRunAt: null, createdAt: 1 });
    expect((await take(deps(dir, { calls: () => calls }), itemKey.moved("call", "c1"), { ...call, botIds: ["gone"] })).status).toBe(409);
  });
});

describe("My Cloud sets a bot's move-only fields", () => {
  it("as this computer has them: its own projects kept beside, an engine or library skill it lacks left out, and absent ones cleared", async () => {
    installLibrarySkill({ name: "digest", instructions: "---\nname: digest\ndescription: Digest.\n---\n\nDigest.\n", source: "test" });
    const d = deps("/data");
    const fields = { hidden: null, pinned: true, chiefOfStaff: true, managedSections: ["Ops", "Ops"], fallback: [{ instanceId: "claude", model: "h" }, { instanceId: "gone", model: "x" }],
      projects: [{ id: "p1", name: "Launch", emoji: "🚀" }], playbooks: [{ key: "k", name: "Close", summary: "s", triggers: ["t"], instructions: "i" }], installedPackage: null,
      assignedSkills: ["digest", "missing"] };
    expect((await take(d, "bot:b1", fields)).status).toBe(200);
    expect(d.patched[0]![1]).toEqual({ pinned: true, managedSections: ["Ops"], fallback: [{ instanceId: "claude", model: "h" }],
      projects: [{ id: "p1", name: "Launch", emoji: "🚀" }, { id: "p-cloud", name: "Mine" }], playbooks: fields.playbooks, installedPackage: undefined, assignedSkills: ["digest"] });
    expect(d.chief).toEqual(["b1"]);
    expect((await take(d, "bot:b1", { hidden: true, chiefOfStaff: false })).status).toBe(200);
    expect(d.patched.at(-1)![1]).toEqual({ hidden: true, chiefOfStaff: false });
    expect((await take(d, "bot:b1", { soul: "not a move field" })).status).toBe(400);
    expect((await take(d, "bot:nobody", { pinned: true })).status).toBe(409);
  });
});

describe("skill extras", () => {
  it("an imported skill arrives with every file and hashes the same as the copy this computer keeps", async () => {
    const input = { name: "invoice-check", skillMd: "---\nname: invoice-check\ndescription: Check.\n---\n\nCheck.\n", files: [{ path: "references/rules.md", content: "Add up.\n", executable: false }],
      executableIntentVersion: 1 as const,
      entry: { description: "Check.", source: "claudeCode" as const, root: "~/.claude/skills", origin: "~/.claude/skills/invoice-check", label: "Claude Code/invoice-check", sha256: createHash("sha256").update("---\nname: invoice-check\ndescription: Check.\n---\n\nCheck.\n").digest("hex"), warnings: [] } };
    const d = deps("/data", { claudeCodeSkills: () => [input] });
    const [listed] = moveItems(d, new Set()).filter((item) => item.kind === "imported-skill");
    expect(listed).toEqual({ key: itemKey.moved("imported-skill", "invoice-check"), kind: "imported-skill", label: "invoice-check", id: "invoice-check", parts: { files: importedSkillHash(input) } });
    expect((await take(deps("/data"), listed!.key, kindRecord(d, "imported-skill", "invoice-check")!.record)).status).toBe(200);
    expect(readImportedSkills()["invoice-check"]).toMatchObject({ source: "claudeCode", label: "Claude Code/invoice-check" });
    const kept = moveItems(deps("/data"), new Set()).find((item) => item.key === listed!.key);
    expect(kept, "the copy kept here now hashes as the person's own folder did").toEqual(listed);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      expect(kindRecord(deps("/data"), "imported-skill", input.name)!.record).toMatchObject({
        executableIntentVersion: 1, files: [{ path: "references/rules.md", content: "Add up.\n", executable: false }],
      });
    } finally { Object.defineProperty(process, "platform", platform); }
    expect((await take(deps("/data"), listed!.key, { ...input, files: [{ path: "../escape.md", content: "x", executable: false }] })).status).toBe(400);
    expect((await take(deps("/data"), listed!.key, { ...input, files: [{ path: "guide\nfile.md", content: "x", executable: false }] })).status).toBe(400);
    const { executableIntentVersion: _version, ...oldSender } = input;
    expect((await take(deps("/data"), listed!.key, oldSender)).status).toBe(400);
    expect((await take(deps("/data"), listed!.key, { ...input, files: [{ ...input.files[0], executable: null }] })).status).toBe(400);
    const file = join(IMPORTED_SKILLS_DIR, input.name, "references", "rules.md");
    chmodSync(file, 0o600);
    try {
      writeFileSync(file, "changed after import\n");
      expect(() => moveItems(deps("/data"), new Set())).toThrow(/changed or could not be checked safely/);
    } finally { writeFileSync(file, "Add up.\n"); chmodSync(file, process.platform === "win32" ? 0o600 : 0o400); }
  });

  it("carries unknown modes without converting them into non-executable intent", async () => {
    const skillMd = "---\nname: unknown-mode\ndescription: Check.\n---\n\nCheck.\n";
    const input = { name: "unknown-mode", skillMd, files: [{ path: "references/rules.md", content: "Add up.\n", executable: null }],
      entry: { description: "Check.", source: "codex" as const, root: "~/.codex/skills", origin: "~/.codex/skills/unknown-mode", label: "Codex/unknown-mode",
        sha256: createHash("sha256").update(skillMd).digest("hex"), warnings: [] } };
    const key = itemKey.moved("imported-skill", input.name);
    expect((await take(deps("/data"), key, input)).status).toBe(409);
    expect(readImportedSkills()[input.name]).toBeUndefined();
    expect(storeImportedSkills([input])[0]!.stored).toBe(true);
    expect(readImportedSkills()[input.name]).toHaveProperty("modeUnknown", true);
    expect(exportImportedSkill(input.name)).toBeNull();
    const record = kindRecord(deps("/data"), "imported-skill", input.name)!.record as typeof input;
    expect(record.files).toEqual(input.files);
    expect(importedSkillHash(record)).toBe(importedSkillHash(input));
    expect(importedSkillHash(record)).not.toBe(importedSkillHash({ ...input, files: [{ ...input.files[0]!, executable: false }] }));
    expect(z.object({ executable: z.boolean() }).safeParse(record.files[0]).success).toBe(false);
  });

  it("a library skill arrives with its review state, and a changed one replaces My Cloud's copy", async () => {
    const text = (body: string) => `---\nname: weekly\ndescription: ${body}\n---\n\n${body}\n`;
    const record = (body: string, reviewState: "approved" | "disabled") => ({ entry: { name: "weekly", description: body, source: "here", reviewState, warnings: [] }, text: text(body) });
    expect((await take(deps("/data"), itemKey.moved("library-skill", "weekly"), record("Weekly.", "approved"))).status).toBe(200);
    expect(readSkillLibraryIndex().weekly).toMatchObject({ reviewState: "approved" });
    expect((await take(deps("/data"), itemKey.moved("library-skill", "weekly"), record("Weekly, shorter.", "approved"))).status).toBe(200);
    expect(readSkillLibraryIndex().weekly).toMatchObject({ description: "Weekly, shorter.", reviewState: "approved" });
  });
});
