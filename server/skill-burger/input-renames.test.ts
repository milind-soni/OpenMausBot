import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import type { Workflow } from "../../shared/skill-burger/format.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createExecutors } from "./executors.ts";
import { createSkillBurgerRoutes } from "./routes.ts";
import { createRunStates } from "./run-state.ts";
import { resumeRun, startRun, type RunDeps } from "./runner.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const call = (id: string, name: string, input: unknown): RunMessage => ({
  id, role: "bot", kind: "activity", tool: { name, ok: true, input: JSON.stringify(input) },
});
const messages: RunMessage[] = [
  { id: "ask", role: "user", kind: "text", text: "Compare https://alpha.example and https://beta.example, then write the summary." },
  call("left", "agent_browser_open", { url: "https://alpha.example" }),
  call("right", "agent_browser_open", { url: "https://beta.example" }),
  call("look", "agent_browser_snapshot", {}),
  call("record", "Bash", { command: 'printf "%s\\n%s\\n" "https://alpha.example" "https://beta.example" > selected.txt' }),
  call("summary", "Write", { file_path: "summary.txt", content: "The comparison considers both sites and identifies their strongest features. ".repeat(5) }),
];

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "burger-input-renames-"));
  roots.push(root);
  const routes = [createSkillBurgerRoutes({ root, messages: () => messages, owns: (bot, thread) => bot === "lead" && thread === "compare", sees: () => true, botIds: () => ["lead"] })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, body?: unknown) => fetch(`${base}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { root, api };
}

it.skipIf(process.platform === "win32").each([
  { name: "swapped names", left: "url_2", right: "url" },
  { name: "a name reused while its old owner moves", left: "url_2", right: "destination" },
  { name: "two fresh names", left: "left", right: "right" },
])("saves and replays distinct inputs with $name", async ({ left, right }) => {
  const { root, api } = await fixture();
  const draft = await (await api("/api/skill-burger-draft", { botId: "lead", threadId: "compare" })).json() as { draft: { inputs: Array<{ name: string }> } };
  expect(draft.draft.inputs.map((input: { name: string }) => input.name)).toEqual(["url", "url_2"]);
  const saved = await api("/api/skill-burgers", { botId: "lead", threadId: "compare", name: "compare-sites", inputs: {
    url: { name: left, value: "https://saved-alpha.example" },
    url_2: { name: right, value: "https://saved-beta.example" },
  } });
  expect(saved.status).toBe(201);
  const savedBody = await saved.json() as { skill: { sha256: string } };
  const read = await (await api("/api/skill-burgers/compare-sites")).json() as { workflow: Workflow };
  const opened: string[] = [];
  const stateDir = join(root, "states");
  const deps: RunDeps = {
    exec: createExecutors({ botId: "lead", cwd: root, async internal(kind, path, body) {
      expect(kind).toBe("browser");
      expect(path).toBe("/api/internal/browser/mcp");
      const frame = body as { params: { name: string; arguments: { url: string } } };
      expect(frame.params.name).toBe("agent_browser_open");
      opened.push(frame.params.arguments.url);
      return { ok: true, body: { result: { content: [{ type: "text", text: "Opened the fixture page" }] } } };
    } }),
    events: { started() {}, ended() {} }, save: (state) => createRunStates(stateDir).save(state),
  };
  const expected = ["https://current-alpha.example", "https://current-beta.example"];
  const result = await startRun({ name: "compare-sites", botId: "lead", threadId: "replay", sha256: savedBody.skill.sha256, workflow: read.workflow, args: { [left]: expected[0], [right]: expected[1] } }, deps);
  expect(result).toMatchObject({ ok: true, status: "needs_input", requiresInput: { type: "ai_step" } });
  expect(readFileSync(join(root, "selected.txt"), "utf8")).toBe(`${expected.join("\n")}\n`);
  expect(opened).toEqual(expected);
  expect(result.requiresInput!.prompt).toContain(`Compare ${expected[0]} and ${expected[1]}`);
  expect(read.workflow.args).toEqual({ [left]: { default: "https://saved-alpha.example", label: "url" }, [right]: { default: "https://saved-beta.example", label: "url" } });
  const state = createRunStates(stateDir).take(result.run, "lead");
  expect(state).not.toBeNull();
  expect(await resumeRun(state!, "Both current sites were compared.", deps)).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(root, "summary.txt"), "utf8")).toBe("Both current sites were compared.");
});

it("rejects two inputs with the same final name without saving a workflow", async () => {
  const { api } = await fixture();
  const saved = await api("/api/skill-burgers", { botId: "lead", threadId: "compare", name: "compare-sites", inputs: { url: { name: "target" }, url_2: { name: "target" } } });
  expect(saved.status).toBe(422);
  expect(await saved.json()).toMatchObject({ error: "There is already an input named target." });
  expect((await api("/api/skill-burgers/compare-sites")).status).toBe(404);
});
