import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Parser } from "tar";

import { BrowserEvidence, EVIDENCE_LIMITS, imageFileName, type StepRecord } from "./browser-evidence.ts";

const fileOfSize = (path: string, bytes: number) => { writeFileSync(path, ""); truncateSync(path, bytes); };

const posix = process.platform !== "win32";
const GEN = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const GEN2 = "7a1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function store(options: { free?: number; now?: () => number; freeFloor?: number } = {}) {
  const root = join(mkdtempSync(join(tmpdir(), "omb-evidence-")), "evidence");
  roots.push(join(root, ".."));
  const free = options.free ?? 100 * 1024 ** 3;
  return new BrowserEvidence({
    root, statfs: async () => ({ bavail: free / 4096, bsize: 4096 }),
    ...(options.now ? { now: options.now } : {}), ...(options.freeFloor ? { freeFloor: options.freeFloor } : {}),
  });
}

function step(evidence: BrowserEvidence, threadId: string, generation = GEN, extra: Partial<StepRecord> = {}): StepRecord {
  return { v: 1, step: evidence.nextStep(), at: 1, threadId, generation, image: null, action: "Clicked the \"Go\" button", ...extra };
}

async function shot(evidence: BrowserEvidence, threadId: string, bytes: Buffer, generation = GEN): Promise<StepRecord> {
  const record = step(evidence, threadId, generation);
  const target = evidence.imageTarget(threadId, generation, record.step);
  if (!("path" in target)) return evidence.commit({ ...record, imageSkipped: target.skipped }, null);
  writeFileSync(target.path, bytes);
  return evidence.commit(record, target.path);
}

const listen = (deps: { exists?: (id: string) => boolean } = {}) => {
  let listener: ((change: { type: string; threadId?: string }) => void) | null = null;
  return {
    deps: { onChange: (next: typeof listener & object) => { listener = next; return () => { listener = null; }; }, threadExists: deps.exists ?? (() => true) },
    emit: (change: { type: string; threadId?: string }) => listener?.(change),
  };
};

describe("the browser step store", () => {
  it.skipIf(!posix)("keeps steps and screenshots private to the server user", async () => {
    const evidence = store();
    await shot(evidence, "thread-1", Buffer.from("jpeg one"));
    const dir = join(evidence.root, "thread-1", GEN);
    expect(statSync(evidence.root).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "steps.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, imageFileName(1))).mode & 0o777).toBe(0o600);
  });

  it("numbers steps once across the instance and its restarts, a block reserved at a time", () => {
    const first = store();
    expect([first.nextStep(), first.nextStep(), first.nextStep()]).toEqual([1, 2, 3]);
    expect(JSON.parse(readFileSync(join(first.root, "state.json"), "utf8"))).toEqual({ nextStep: 1 + EVIDENCE_LIMITS.stepBlock });
    const restarted = new BrowserEvidence({ root: first.root });
    expect(restarted.nextStep()).toBe(1 + EVIDENCE_LIMITS.stepBlock);
  });

  it("stores a screenshot that repeats the previous one once, pointing the step at the earlier image", async () => {
    const evidence = store();
    const one = await shot(evidence, "thread-1", Buffer.from("same page"));
    const two = await shot(evidence, "thread-1", Buffer.from("same page"));
    const three = await shot(evidence, "thread-1", Buffer.from("changed page"));
    expect(two).toMatchObject({ image: one.image, sameAsStep: one.step, sha256: one.sha256 });
    expect(three.sameAsStep).toBeNull();
    expect(readdirSync(join(evidence.root, "thread-1", GEN)).filter((name) => name.endsWith(".jpg")).sort()).toEqual([imageFileName(one.step), imageFileName(three.step)]);
    const listed = evidence.list("thread-1");
    expect(listed.steps.map((entry) => entry.imageUrl)).toEqual([
      `/api/threads/thread-1/evidence/${GEN}/${one.image}`, `/api/threads/thread-1/evidence/${GEN}/${one.image}`, `/api/threads/thread-1/evidence/${GEN}/${three.image}`,
    ]);
  });

  it("drops an empty or oversized screenshot and says why", async () => {
    const evidence = store();
    expect((await shot(evidence, "thread-1", Buffer.alloc(0))).imageSkipped).toBe("capture-failed");
    expect((await shot(evidence, "thread-1", Buffer.alloc(EVIDENCE_LIMITS.imageBytes + 1))).imageSkipped).toBe("too-large");
    expect(readdirSync(join(evidence.root, "thread-1", GEN)).filter((name) => name.endsWith(".jpg"))).toEqual([]);
  });

  it("stops screenshots, never steps, when the disk runs low or the store is full", async () => {
    const low = store({ free: 512 * 1024 ** 2 });
    await low.sweep();
    expect((await shot(low, "thread-1", Buffer.from("x"))).imageSkipped).toBe("disk-low");
    expect(low.list("thread-1").steps).toHaveLength(1);
    // A quarter of the free space caps the whole store: here, with the floor scaled down a thousandfold, 1.25 MB free
    // allows 320 KB. Real sizes would need a 330 MB file, which a Windows runner can take over 40 s to write.
    const small = store({ free: 1.25 * 1024 ** 2, freeFloor: EVIDENCE_LIMITS.freeFloor / 1024 });
    await small.sweep();
    mkdirSync(join(small.root, "thread-old", GEN), { recursive: true });
    fileOfSize(join(small.root, "thread-old", GEN, imageFileName(9)), 330 * 1024);
    await small.sweep();
    // Over the cap: the oldest other conversation's screenshots go first, its steps stay.
    writeFileSync(join(small.root, "thread-old", GEN, "steps.jsonl"), `${JSON.stringify({ v: 1, step: 9, threadId: "thread-old", generation: GEN, image: imageFileName(9) })}\n`);
    await small.sweep();
    expect(existsSync(join(small.root, "thread-old", GEN, imageFileName(9)))).toBe(false);
    expect(small.list("thread-old").steps[0]).toMatchObject({ imageUrl: null, imageGone: "evicted" });
    expect((await shot(small, "thread-new", Buffer.from("fits"))).image).not.toBeNull();
  });

  it("caps one conversation at 200 MB of screenshots", async () => {
    const evidence = store();
    mkdirSync(join(evidence.root, "thread-1", GEN2), { recursive: true });
    fileOfSize(join(evidence.root, "thread-1", GEN2, imageFileName(5)), EVIDENCE_LIMITS.threadBytes);
    expect((await shot(evidence, "thread-1", Buffer.from("x"))).imageSkipped).toBe("thread-cap");
    expect((await shot(evidence, "thread-2", Buffer.from("x"))).image).not.toBeNull();
  });

  it("stops taking steps once a conversation's step lines reach their cap, until old ones expire", async () => {
    const evidence = store();
    const steps = join(evidence.root, "thread-1", GEN2, "steps.jsonl");
    mkdirSync(join(evidence.root, "thread-1", GEN2), { recursive: true });
    writeFileSync(steps, Buffer.alloc(EVIDENCE_LIMITS.threadStepBytes - 100, 0x20));
    expect(evidence.accepts("thread-1")).toBe(true);
    await evidence.commit(step(evidence, "thread-1"), null);
    expect(evidence.accepts("thread-1")).toBe(false);
    await expect(evidence.commit(step(evidence, "thread-1"), null)).rejects.toThrow(/no more browser steps/);
    expect(evidence.list("thread-1").steps).toHaveLength(1);
    expect(evidence.accepts("thread-2")).toBe(true);
    const old = new Date(Date.now() - EVIDENCE_LIMITS.retentionMs - 60_000);
    utimesSync(steps, old, old);
    utimesSync(join(evidence.root, "thread-1", GEN2), old, old);
    await evidence.sweep();
    expect(evidence.accepts("thread-1")).toBe(true);
  });

  it("never evicts a generation being written now", async () => {
    let now = Date.now();
    const evidence = store({ free: 1.25 * 1024 ** 2, now: () => now });
    await shot(evidence, "thread-busy", Buffer.from("live turn"));
    // The store is over its 320 KB cap, and the busy turn holds most of it.
    fileOfSize(join(evidence.root, "thread-busy", GEN, imageFileName(500)), 300 * 1024);
    mkdirSync(join(evidence.root, "thread-idle", GEN2), { recursive: true });
    fileOfSize(join(evidence.root, "thread-idle", GEN2, imageFileName(7)), 40 * 1024);
    now += 60_000;
    await evidence.sweep();
    expect(readdirSync(join(evidence.root, "thread-busy", GEN)).filter((name) => name.endsWith(".jpg"))).toHaveLength(2);
    expect(readdirSync(join(evidence.root, "thread-idle", GEN2)).filter((name) => name.endsWith(".jpg"))).toEqual([]);
  });

  it("deletes a conversation's evidence with it, and at boot what no conversation owns", async () => {
    const evidence = store();
    await shot(evidence, "thread-gone", Buffer.from("a"));
    await shot(evidence, "thread-kept", Buffer.from("b"));
    await shot(evidence, "thread-deleted", Buffer.from("c"));
    const { deps, emit } = listen({ exists: (id) => id !== "thread-gone" });
    evidence.attach(deps);
    try {
      await evidence.sweep();
      expect(existsSync(join(evidence.root, "thread-gone"))).toBe(false);
      expect(existsSync(join(evidence.root, "thread-kept"))).toBe(true);
      emit({ type: "thread.deleted", threadId: "thread-deleted" });
      expect(existsSync(join(evidence.root, "thread-deleted"))).toBe(false);
      emit({ type: "message", threadId: "thread-kept" });
      expect(existsSync(join(evidence.root, "thread-kept"))).toBe(true);
    } finally { evidence.detach(); }
  });

  it("deletes generations after 30 days", async () => {
    const evidence = store();
    await shot(evidence, "thread-1", Buffer.from("old"));
    await shot(evidence, "thread-1", Buffer.from("new"), GEN2);
    const old = new Date(Date.now() - EVIDENCE_LIMITS.retentionMs - 60_000);
    for (const path of [join(evidence.root, "thread-1", GEN, "steps.jsonl"), join(evidence.root, "thread-1", GEN)]) utimesSync(path, old, old);
    await evidence.sweep();
    expect(existsSync(join(evidence.root, "thread-1", GEN))).toBe(false);
    expect(existsSync(join(evidence.root, "thread-1", GEN2))).toBe(true);
  });

  it("serves only well-formed names of regular files inside the store", async () => {
    const evidence = store();
    const written = await shot(evidence, "thread-1", Buffer.from("jpeg"));
    expect(evidence.imageFile("thread-1", GEN, written.image!)).not.toBeNull();
    expect(evidence.imageFile("thread-1", GEN, "../steps.jsonl")).toBeNull();
    expect(evidence.imageFile("..", GEN, written.image!)).toBeNull();
    expect(evidence.imageFile("thread-1", "../../x", written.image!)).toBeNull();
    expect(evidence.imageFile("thread-1", GEN, "step-1.jpg")).toBeNull();
    if (posix) {
      const outside = join(evidence.root, "..", "secret.jpg");
      writeFileSync(outside, "not evidence");
      symlinkSync(outside, join(evidence.root, "thread-1", GEN, imageFileName(999_999)));
      expect(evidence.imageFile("thread-1", GEN, imageFileName(999_999))).toBeNull();
      symlinkSync(join(evidence.root, "thread-1", GEN, written.image!), join(evidence.root, "thread-1", GEN, imageFileName(999_998)));
      expect(evidence.imageFile("thread-1", GEN, imageFileName(999_998))).toBeNull();
      mkdirSync(join(evidence.root, "..", "elsewhere"));
      writeFileSync(join(evidence.root, "..", "elsewhere", imageFileName(5)), "not evidence");
      symlinkSync(join(evidence.root, "..", "elsewhere"), join(evidence.root, "thread-1", GEN2));
      expect(evidence.imageFile("thread-1", GEN2, imageFileName(5))).toBeNull();
    }
  });

  it("exports a conversation as one tar: index.json and the screenshots, under POSIX paths", async () => {
    const evidence = store();
    const one = await shot(evidence, "thread-1", Buffer.from("first page"));
    await evidence.commit({ ...step(evidence, "thread-1"), imageSkipped: "secret-on-screen" }, null);
    const two = await shot(evidence, "thread-1", Buffer.from("other turn"), GEN2);
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (chunk: Buffer) => chunks.push(chunk));
    await evidence.exportTar("thread-1", out);
    out.end();
    const files = new Map<string, Buffer>();
    await new Promise<void>((resolve, reject) => {
      const parser = new Parser({ onReadEntry: (entry) => {
        const parts: Buffer[] = [];
        entry.on("data", (data: Buffer) => parts.push(data));
        entry.on("end", () => files.set(entry.path, Buffer.concat(parts)));
      } });
      parser.on("end", resolve);
      parser.on("error", reject);
      parser.end(Buffer.concat(chunks));
    });
    expect([...files.keys()].sort()).toEqual([`${GEN}/${one.image}`, `${GEN2}/${two.image}`, "index.json"].sort());
    expect(files.get(`${GEN}/${one.image}`)!.toString()).toBe("first page");
    const index = JSON.parse(files.get("index.json")!.toString());
    expect(index).toMatchObject({ v: 1, threadId: "thread-1" });
    expect(index.steps.map((entry: StepRecord) => entry.image)).toEqual([`${GEN}/${one.image}`, null, `${GEN2}/${two.image}`]);
    expect(JSON.stringify(index)).not.toContain("imageUrl");
  });

  it("exports a big conversation reading each step once, not once per page of 500", async () => {
    const evidence = store();
    for (let index = 0; index < 1_200; index++) await evidence.commit(step(evidence, "thread-big", index < 600 ? GEN : GEN2), null);
    const parse = vi.spyOn(JSON, "parse");
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (chunk: Buffer) => chunks.push(chunk));
    let parsed = 0;
    try {
      await evidence.exportTar("thread-big", out);
      parsed = parse.mock.calls.length;
    } finally { parse.mockRestore(); }
    expect(parsed).toBeGreaterThanOrEqual(1_200);
    expect(parsed).toBeLessThan(1_300);
    const tar = Buffer.concat(chunks);
    const index = JSON.parse(tar.subarray(512, 512 + Number.parseInt(tar.subarray(124, 136).toString().trim(), 8)).toString());
    expect(index.steps).toHaveLength(1_200);
    const order = index.steps.map((entry: StepRecord) => entry.step);
    expect(order).toEqual([...order].sort((a: number, b: number) => a - b));
  });
});
