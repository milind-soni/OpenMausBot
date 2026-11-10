import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as promises from "node:fs/promises";
import { afterAll, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const data = mkdtempSync(join(tmpdir(), "omb-task-references-"));
process.env.OMB_DATA_DIR = data;
const { TASK_WORKSPACES_DIR, workspaceDir } = await import("./workspace.ts");
const { taskSkillsMayReferTo } = await import("./skill-task-references.ts");
const { nativeSkillLinksMayReferTo } = await import("./skill-native-reference.ts");
afterAll(() => rmSync(data, { recursive: true, force: true }));

it.skipIf(process.platform === "win32")("retains a revision while a task link points to it, including a nested target", async () => {
  const old = join(data, "old"), next = join(data, "next"), links = join(TASK_WORKSPACES_DIR, "bot-a", "thread-a", ".claude", "skills");
  mkdirSync(join(old, "references"), { recursive: true }); mkdirSync(next); mkdirSync(links, { recursive: true });
  const link = join(links, "runbook"); symlinkSync(join(old, "references"), link);
  expect((await taskSkillsMayReferTo("bot-a", "runbook", [old, next]))).toEqual([true, false]);
  rmSync(link); symlinkSync(next, link);
  expect((await taskSkillsMayReferTo("bot-a", "runbook", [old, next]))).toEqual([false, true]);
});

it.skipIf(process.platform === "win32")("keeps the revision when a task root is a symlink and never changes its destination", async () => {
  const outside = join(data, "outside"), bot = join(TASK_WORKSPACES_DIR, "bot-b");
  mkdirSync(outside); writeFileSync(join(outside, "keep"), "outside"); mkdirSync(bot, { recursive: true });
  symlinkSync(outside, join(bot, "thread-b"));
  expect((await taskSkillsMayReferTo("bot-b", "runbook", [join(data, "old")]))).toEqual([true]);
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
  expect(existsSync(join(outside, ".claude"))).toBe(false);
});

it.skipIf(process.platform === "win32")("treats nested, dangling and redirected native links conservatively", () => {
  const bot = "bot-native", old = join(data, "native-old"), next = join(data, "native-next"), links = join(workspaceDir(bot), ".claude", "skills");
  mkdirSync(join(old, "references"), { recursive: true }); mkdirSync(next); mkdirSync(links, { recursive: true });
  const link = join(links, "runbook"); symlinkSync(join(old, "references"), link);
  expect(nativeSkillLinksMayReferTo(bot, "runbook", old)).toBe(true);
  rmSync(link); symlinkSync(join(data, "missing"), link);
  expect(nativeSkillLinksMayReferTo(bot, "runbook", old)).toBe(true);
  rmSync(link); symlinkSync(next, link);
  expect(nativeSkillLinksMayReferTo(bot, "runbook", old)).toBe(false);
});

it("fails closed when task enumeration exceeds its bound", async () => {
  const bot = join(TASK_WORKSPACES_DIR, "bot-cap"); mkdirSync(bot, { recursive: true });
  for (let n = 0; n < 4_097; n++) writeFileSync(join(bot, `invalid.${n}`), "");
  expect((await taskSkillsMayReferTo("bot-cap", "runbook", [join(data, "old")]))).toEqual([true]);
});

it("scans dormant tasks without blocking timers and preserves conservative results", async () => {
  const bot = join(TASK_WORKSPACES_DIR, "bot-async"), target = join(data, "async-old");
  mkdirSync(bot, { recursive: true }); mkdirSync(target);
  for (let n = 0; n < 256; n++) mkdirSync(join(bot, `thread-${n}`));
  let ticks = 0, complete = false;
  const timer = setInterval(() => { if (!complete) ticks++; }, 1);
  try {
    expect(await taskSkillsMayReferTo("bot-async", "runbook", [target])).toEqual([false]);
    complete = true;
    expect(ticks).toBeGreaterThan(0);
    if (process.platform !== "win32") {
      symlinkSync(target, join(bot, "thread-0", ".claude"));
      expect(await taskSkillsMayReferTo("bot-async", "runbook", [target])).toEqual([true]);
    }
    expect(await taskSkillsMayReferTo("bot-cap", "runbook", [target])).toEqual([true]);
  } finally { clearInterval(timer); }
});

it.each([".claude", ".agents", ".grok"])("checks dormant links in %s", async (family) => {
  const bot = `family-${family.slice(1)}`, target = join(data, bot, "old");
  const links = join(TASK_WORKSPACES_DIR, bot, "thread-one", family, "skills");
  mkdirSync(target, { recursive: true }); mkdirSync(links, { recursive: true });
  symlinkSync(target, join(links, "runbook"), "junction");
  expect(await taskSkillsMayReferTo(bot, "runbook", [target, join(data, "other")])).toEqual([true, false]);
});

it("keeps all revisions when task metadata changes during inspection", async () => {
  const bot = "metadata-race", task = join(TASK_WORKSPACES_DIR, bot, "thread-one");
  mkdirSync(task, { recursive: true });
  const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).lstat;
  const key = (value: string) => {
    const normal = resolve(value).replace(/^\\\\\?\\/, "");
    return process.platform === "win32" ? normal.toLowerCase() : normal;
  };
  const changed = vi.mocked(promises.lstat).mockImplementation(async (...args) => {
    const stat = await original(...args);
    const path = typeof args[0] === "string" ? args[0] : "";
    if (path !== "" && key(path) === key(task) && !existsSync(join(task, "changed"))) {
      mkdirSync(join(task, "changed"));
      // NTFS stamps move in about 16 ms ticks, so a directory created in the tick just read keeps that stamp.
      const moved = new Date(stat.mtime.getTime() + 2_000);
      utimesSync(task, moved, moved);
    }
    return stat;
  });
  try { expect(await taskSkillsMayReferTo(bot, "runbook", [join(data, "old"), join(data, "next")])).toEqual([true, true]); }
  finally { changed.mockImplementation(original); }
});
