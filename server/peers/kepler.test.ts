import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keplerNotify, readKeplerInbox } from "./kepler.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("keplerNotify", () => {
  it("writes drop file and inbox line", () => {
    const drop = mkdtempSync(join(tmpdir(), "musterd-kepler-"));
    dirs.push(drop);
    const env = { MUSTERD_KEPLER_DROP_DIR: drop, MUSTERD_KEPLER_TASK_ID: "task:test" };
    const result = keplerNotify({
      botId: "bot-1",
      botName: "Snake",
      threadId: "thread-1",
      summary: "Ready for Siva merge on #27",
      refs: ["https://example.com/pr/27"],
    }, env);
    expect(result.taskId).toBe("task:test");
    const body = JSON.parse(readFileSync(result.path, "utf8"));
    expect(body.summary).toContain("#27");
    expect(readKeplerInbox(5, env)).toHaveLength(1);
    const note = readFileSync(join(drop, "task-notes", "task:test.md"), "utf8");
    expect(note).toContain("Snake");
  });

  it("rejects empty summary", () => {
    const drop = mkdtempSync(join(tmpdir(), "musterd-kepler-"));
    dirs.push(drop);
    expect(() => keplerNotify({
      botId: "b", threadId: "t", summary: "  ",
    }, { MUSTERD_KEPLER_DROP_DIR: drop })).toThrow(/summary/);
  });
});
