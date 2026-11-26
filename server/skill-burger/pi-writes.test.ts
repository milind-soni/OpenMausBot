import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { ensureDirs } from "../config.ts";
import { PiDriver } from "../drivers/pi.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { recordEvents } from "../testing/events.ts";
import { createSkillBurgerRoutes } from "./routes.ts";
import type { RunEnvelope } from "./runner.ts";
import { createSkillBurgerRuns, RESUME_PATH, RUN_PATH } from "./runs.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

// The replayed shell steps are quoted for /bin/sh. Under cmd.exe on Windows CI they left no file and no output while the run
// still reported ok, so these cases skip Windows like the other shell-replay tests (working-directory, recorded-inputs).
async function replay(content: string, name = "write", path = "report.txt") {
  const home = mkdtempSync(join(tmpdir(), "burger-pi-write-"));
  roots.push(home);
  const original = join(home, "original");
  const root = join(home, "replay");
  mkdirSync(original);
  mkdirSync(root);
  ensureDirs();
  const cli = fileURLToPath(new URL("../testing/fake-pi-cli.ts", import.meta.url));
  chmodSync(cli, 0o755);
  const instance = await PiDriver.create({
    instanceId: "burger-pi-write", displayName: "Fixture", enabled: true, config: { cli, fullAuto: false },
    environment: { HOME: home, FAKE_PI_MODE: "tooluse", FAKE_PI_TOOLS: JSON.stringify([
      { name, args: { path, content } },
      { name: "bash", args: { command: `node -e "require('node:fs').copyFileSync('${path}','delivered.txt')"` } },
      { name: "bash", args: { command: "node -e \"require('node:fs').writeFileSync('complete.txt','complete')\"" } },
    ]) },
  });
  const recorder = recordEvents(instance.adapter);
  const messages: RunMessage[] = [{ id: "ask", role: "user", kind: "text", text: "Write the report and deliver a copy" }];
  try {
    await instance.adapter.sendTurn({ threadId: "write-report", text: messages[0]!.text!, cwd: original });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    for (const start of recorder.events) {
      if (start.type !== "item.started" || start.itemType !== "tool") continue;
      const end = recorder.events.find((event) => event.type === "item.completed" && event.itemId === start.itemId);
      if (end?.type !== "item.completed" || end.itemType !== "tool") throw new Error("missing tool completion");
      messages.push({ id: start.itemId!, role: "bot", kind: "activity", tool: { name: start.title!, itemId: start.itemId, summary: start.summary, input: start.input, output: end.output, ok: end.ok } });
    }
    expect(messages.map((message) => message.tool?.name).filter(Boolean)).toEqual([name, "bash", "bash"]);
  } finally {
    recorder.stop();
    await instance.dispose();
  }

  const routes = createSkillBurgerRoutes({ root, messages: () => messages, owns: () => true, sees: () => true, botIds: () => ["lead"] });
  let runs = createSkillBurgerRuns({ root, dataDir: root });
  const turn = { botId: "lead", threadId: "write-report", cwd: root, mayEditBurgers: true, publish() {}, internal: async () => { throw new Error("unexpected external call"); } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    if (!await dispatchRoutes([routes, runs.internalRoutes(turn)], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async <T>(url: string, body?: unknown) => {
    const response = await fetch(`${base}${url}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as T;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const saved = await api<{ skill: { name: string } }>("/api/skill-burgers", { botId: "lead", threadId: "write-report", summary: "Deliver the report" });
  const read = await api<{ workflow: unknown }>(`/api/skill-burgers/${saved.skill.name}`);
  const workflow = workflowSchema.parse(read.workflow);
  return {
    home, root, workflow, messages,
    run: () => api<RunEnvelope>(RUN_PATH, { name: saved.skill.name }),
    resume: (run: string) => {
      runs = createSkillBurgerRuns({ root, dataDir: root });
      return api<RunEnvelope>(RESUME_PATH, { run, response: "The complete report has been written." });
    },
  };
}

it.skipIf(process.platform === "win32")("replays a native Pi write before the recorded shell command consumes its file", async () => {
  const content = "north,south\n12,34\n";
  const h = await replay(content);
  expect(existsSync(join(h.root, "report.txt"))).toBe(false);
  expect(await h.run()).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(h.root, "delivered.txt"), "utf8")).toBe(content);
  expect(readFileSync(join(h.root, "complete.txt"), "utf8")).toBe("complete");
  expect(h.workflow.steps[0]).toMatchObject({ kind: "file", path: "report.txt", content });
});

it.skipIf(process.platform === "win32")("preserves an empty Pi write instead of copying stale contents", async () => {
  const h = await replay("");
  writeFileSync(join(h.root, "report.txt"), "stale report");
  expect(await h.run()).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(h.root, "report.txt"), "utf8")).toBe("");
  expect(readFileSync(join(h.root, "delivered.txt"), "utf8")).toBe("");
});

it.skipIf(process.platform === "win32")("hands a shortened Pi write to AI before allowing its file consumer", async () => {
  const content = "report contents\n".repeat(600);
  const h = await replay(content);
  expect(h.messages[1]!.tool?.input).toContain("[… preview shortened]");
  const paused = await h.run();
  expect(paused).toMatchObject({ status: "needs_input", requiresInput: { step: "s1", type: "ai_step" } });
  expect(existsSync(join(h.root, "report.txt"))).toBe(false);
  expect(existsSync(join(h.root, "delivered.txt"))).toBe(false);
  writeFileSync(join(h.root, "report.txt"), content);
  expect(await h.resume(paused.run)).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(h.root, "delivered.txt"), "utf8")).toBe(content);
});

it("keeps an added MCP server's write on its existing AI handoff", async () => {
  const h = await replay("external contents", "mcp__notes__write");
  const paused = await h.run();
  expect(paused).toMatchObject({ status: "needs_input", requiresInput: { step: "s1", type: "ai_step" } });
  expect(existsSync(join(h.root, "report.txt"))).toBe(false);
  expect(existsSync(join(h.root, "delivered.txt"))).toBe(false);
});

it("applies the existing workspace boundary to a retained Pi file target", async () => {
  const h = await replay("changed outside", "write", "../outside.txt");
  writeFileSync(join(h.home, "outside.txt"), "original outside");
  expect(await h.run()).toMatchObject({ ok: false, error: { type: "step_failed", step: "s1", message: expect.stringContaining("only inside") } });
  expect(readFileSync(join(h.home, "outside.txt"), "utf8")).toBe("original outside");
  expect(existsSync(join(h.root, "delivered.txt"))).toBe(false);
});
