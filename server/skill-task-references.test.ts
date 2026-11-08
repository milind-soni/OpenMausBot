import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

const data = mkdtempSync(join(tmpdir(), "omb-task-references-"));
process.env.OMB_DATA_DIR = data;
const { TASK_WORKSPACES_DIR, workspaceDir } = await import("./workspace.ts");
const { taskSkillsMayReferTo } = await import("./skill-task-references.ts");
const { nativeSkillLinksMayReferTo } = await import("./skill-native-reference.ts");
afterAll(() => rmSync(data, { recursive: true, force: true }));

it.skipIf(process.platform === "win32")("retains a revision while a task link points to it, including a nested target", () => {
  const old = join(data, "old"), next = join(data, "next"), links = join(TASK_WORKSPACES_DIR, "bot-a", "thread-a", ".claude", "skills");
  mkdirSync(join(old, "references"), { recursive: true }); mkdirSync(next); mkdirSync(links, { recursive: true });
  const link = join(links, "runbook"); symlinkSync(join(old, "references"), link);
  expect(taskSkillsMayReferTo("bot-a", "runbook", [old, next])).toEqual([true, false]);
  rmSync(link); symlinkSync(next, link);
  expect(taskSkillsMayReferTo("bot-a", "runbook", [old, next])).toEqual([false, true]);
});

it.skipIf(process.platform === "win32")("keeps the revision when a task root is a symlink and never changes its destination", () => {
  const outside = join(data, "outside"), bot = join(TASK_WORKSPACES_DIR, "bot-b");
  mkdirSync(outside); writeFileSync(join(outside, "keep"), "outside"); mkdirSync(bot, { recursive: true });
  symlinkSync(outside, join(bot, "thread-b"));
  expect(taskSkillsMayReferTo("bot-b", "runbook", [join(data, "old")])).toEqual([true]);
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

it("fails closed when task enumeration exceeds its bound", () => {
  const bot = join(TASK_WORKSPACES_DIR, "bot-cap"); mkdirSync(bot, { recursive: true });
  for (let n = 0; n < 4_097; n++) writeFileSync(join(bot, `invalid.${n}`), "");
  expect(taskSkillsMayReferTo("bot-cap", "runbook", [join(data, "old")])).toEqual([true]);
});
