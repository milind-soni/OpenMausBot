import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import { createExecutors } from "./executors.ts";
import { createRunStates } from "./run-state.ts";
import { resumeRun, startRun, type RunDeps, type RunEnvelope } from "./runner.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

async function reviewing() {
  const root = mkdtempSync(join(tmpdir(), "burger-review-"));
  roots.push(root);
  const stateDir = join(root, "states");
  const roster = [{ id: "kiwi", name: "Kiwi" }, { id: "rio", name: "Rio" }];
  const sent: Array<{ botIds: string[]; message: string; rework?: boolean }> = [];
  const assignments = new Map<string, string>();
  const exec = createExecutors({
    botId: "lead", cwd: root,
    async internal(kind, path, body) {
      expect(kind).toBe("agents");
      if (path.startsWith("/api/internal/agents?")) return { ok: true, body: { bots: roster } };
      if (path.startsWith("/api/internal/assignment-status?")) {
        const id = new URL(path, "http://localhost").searchParams.get("id")!;
        expect(assignments.has(id)).toBe(true);
        return { ok: true, body: { assignment: { status: "completed", result: assignments.get(id) } } };
      }
      expect(path).toBe("/api/internal/coordinate-bots");
      const call = body as { botIds: string[]; message: string; rework?: boolean };
      sent.push(call);
      const receipts = call.botIds.map((botId) => {
        const bot = roster.find((one) => one.id === botId)!;
        const requestId = `req-${sent.length}-${botId}`;
        assignments.set(requestId, `${bot.name}: ${call.rework ? "corrected report with URLs" : "initial report"}`);
        return { botId, botName: bot.name, requestId };
      });
      return { ok: true, body: { receipts } };
    },
  });
  const deps: RunDeps = {
    exec, events: { started() {}, ended() {} }, save: (state) => createRunStates(stateDir).save(state),
  };
  const workflow = workflowSchema.parse({
    version: 1, summary: "Review a site", args: {}, steps: [
      {
        id: "s1", kind: "delegate", label: "Ask the testers", review: { rounds: 1 },
        tasks: roster.map((bot) => ({ bot, message: `Check the site for ${bot.name}'s part`, doneWhen: "Every finding names its URL" })),
      },
      { id: "s2", kind: "file", label: "Publish the report", path: "report.txt", content: { $step: "s1", path: "text" } },
    ],
  });
  const resume = async (envelope: RunEnvelope, response: string) => {
    const state = createRunStates(stateDir).take(envelope.requiresInput!.resumeToken, "lead");
    expect(state).not.toBeNull();
    return resumeRun(state!, response, deps);
  };
  const first = await startRun({ name: "review-site", botId: "lead", threadId: "t", sha256: "x", workflow }, deps);
  expect(first).toMatchObject({ status: "needs_input", requiresInput: { type: "teammates" } });
  const review = await resume(first, "back");
  expect(review).toMatchObject({ status: "needs_input", requiresInput: { type: "review" } });
  return { review, resume, sent, report: join(root, "report.txt") };
}

it.each([
  '{"redo":{"Kiwii":"Include the checked URLs"}}',
  '{"redo":{"Kiwi":"Include the checked URLs","Roi":"Check the timing again"}}',
  '{"redo":{"Kiwi":"   "}}',
  '{"redo":{"Kiwi":["Include the checked URLs"]}}',
])("keeps an invalid review pending instead of discarding its corrections: %s", async (response) => {
  const h = await reviewing();
  const pending = await h.resume(h.review, response);
  expect(h.sent).toHaveLength(2);
  expect(existsSync(h.report)).toBe(false);
  expect(pending).toMatchObject({ status: "needs_input", requiresInput: { type: "review" } });

  const rework = await h.resume(pending, '{"redo":{" @kIwI ":"Include the checked URLs"}}');
  expect(rework).toMatchObject({ status: "needs_input", requiresInput: { type: "teammates" } });
  expect(h.sent).toHaveLength(3);
  expect(h.sent[2]).toMatchObject({ botIds: ["kiwi"], rework: true, message: expect.stringContaining("Include the checked URLs") });
  const done = await h.resume(rework, "back");
  expect(done).toMatchObject({ ok: true, status: "ok" });
  const report = readFileSync(h.report, "utf8");
  expect(report).toContain("Kiwi: corrected report with URLs");
  expect(report).toContain("Rio: initial report");
});

it.each(['{"redo":{}}', "done"])("still completes an explicit approval: %s", async (response) => {
  const h = await reviewing();
  expect(await h.resume(h.review, response)).toMatchObject({ ok: true, status: "ok" });
  expect(h.sent).toHaveLength(2);
  expect(readFileSync(h.report, "utf8")).toContain("Kiwi: initial report");
});
