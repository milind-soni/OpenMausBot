import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { workflowSchema, type Workflow } from "../../shared/skill-burger/format.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createExecutors } from "./executors.ts";
import { createSkillBurgerRoutes } from "./routes.ts";
import { createRunStates } from "./run-state.ts";
import { resumeRun, startRun, type RunDeps } from "./runner.ts";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const recordedEmail = "new@example.com";
const priorEmail = "old@example.com";
const runCall = (id: string, output: string): RunMessage => ({
  id, role: "bot", kind: "activity", tool: { name: "mcp__agents__run_workflow", input: "{}", output, ok: true, itemId: id },
});

async function fixture(kind: "paths" | "fix", action?: RunMessage) {
  const root = mkdtempSync(join(tmpdir(), "burger-recorded-inputs-"));
  roots.push(root);
  const messages: RunMessage[] = [
    { id: "ask", role: "user", kind: "text", text: `Add the invoice status for ${recordedEmail}` },
    runCall("handed", kind === "fix" ? "The Skill Burger stopped at s2, resume recorded-run" : "The Skill Burger needs this case, resume recorded-run"),
    action ?? { id: "sent", role: "bot", kind: "activity", tool: {
      name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", itemId: "sent", ok: true,
      input: JSON.stringify({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: recordedEmail, subject: "Report" } }] }),
    } },
    runCall("resumed", "The Skill Burger ran"),
  ];
  const route = createSkillBurgerRoutes({
    root, botIds: () => ["lead"], messages: () => messages,
    owns: (botId, threadId) => botId === "lead" && threadId === "t", sees: () => true,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { workflow: Workflow; skill: { sha256: string }; error?: string } };
  };
  return { api, root };
}

it.each([
  ["paths", "missing"], ["paths", "collision"], ["paths", "shared"],
  ["fix", "missing"], ["fix", "collision"], ["fix", "shared"],
] as const)("keeps recorded inputs when saving %s with %s existing bindings", async (kind, binding) => {
  const { api, root } = await fixture(kind);
  const existing = binding === "shared" ? recordedEmail : priorEmail;
  const original = workflowSchema.parse({
    version: 1, summary: "Send reports", args: binding === "missing" ? {} : { recipient: { default: existing, label: "Original recipient" } },
    steps: [
      { id: "s1", kind: "file", label: "Save existing recipient", path: "existing.txt", content: binding === "missing" ? "unchanged" : { $arg: "recipient" } },
      ...(kind === "paths" ? [{ id: "d1", kind: "decide", label: "Choose the path", prompt: "Which path?", cases: ["original", "added"] }] : []),
      { id: "s2", kind: "file", label: "Finish", path: "complete.txt", content: "done" },
    ],
  });
  expect((await api("/api/skill-burgers", { name: "reports", botId: "lead", workflow: original })).status).toBe(201);
  const changed = await api(`/api/skill-burgers/reports/${kind}`, {
    runBotId: "lead", threadId: "t", run: "recorded-run", ...(kind === "paths" ? { decide: "d1", case: "added" } : { step: "s2" }),
  });
  expect(changed.status, changed.body.error).toBe(200);
  const { workflow } = (await api("/api/skill-burgers/reports")).body;
  const sent: Array<Record<string, unknown>> = [];
  const replay = async (label: string, args?: Record<string, unknown>) => {
    const cwd = join(root, label);
    mkdirSync(cwd);
    const states = join(cwd, "states");
    const exec = createExecutors({
      botId: "lead", cwd,
      async internal(channel, path, body) {
        expect(channel).toBe("connectors");
        expect(path).toBe("/api/internal/connectors/mcp");
        const tool = (body as { params: { arguments: { tools: Array<{ tool_slug: string; arguments: Record<string, unknown> }> } } }).params.arguments.tools[0]!;
        expect(tool.tool_slug).toBe("GMAIL_SEND_EMAIL");
        sent.push(tool.arguments);
        return { ok: true, body: { result: { content: [{ type: "text", text: JSON.stringify({ data: { results: [{ tool_slug: tool.tool_slug, response: { successful: true, data: { id: "fixture-email" } } }] } }) }] } } };
      },
    });
    const deps: RunDeps = { exec, events: { started() {}, ended() {} }, save: (state) => createRunStates(states).save(state) };
    let result = await startRun({ name: "reports", botId: "lead", threadId: label, sha256: changed.body.skill.sha256, workflow, args }, deps);
    if (kind === "paths") {
      expect(result.requiresInput?.type).toBe("decide");
      const saved = createRunStates(states).take(result.requiresInput!.resumeToken, "lead");
      expect(saved).not.toBeNull();
      result = await resumeRun(saved!, "added", deps);
    }
    expect(result).toMatchObject({ ok: true, status: "ok" });
    expect(readFileSync(join(cwd, "complete.txt"), "utf8")).toBe("done");
    return cwd;
  };
  const cwd = await replay("default");
  expect(sent).toEqual([{ recipient_email: recordedEmail, subject: "Report" }]);
  expect(readFileSync(join(cwd, "existing.txt"), "utf8")).toBe(binding === "missing" ? "unchanged" : existing);
  const input = Object.entries(workflow.args).find(([, arg]) => arg.default === recordedEmail);
  expect(input).toBeDefined();
  if (binding === "collision") expect(input![0]).not.toBe("recipient");
  if (binding !== "missing") expect(workflow.args.recipient).toEqual(original.args.recipient);
  await replay("overridden", { [input![0]]: "override@example.com" });
  expect(sent[1]).toEqual({ recipient_email: "override@example.com", subject: "Report" });
  if (binding === "shared") expect(Object.keys(workflow.args)).toEqual(["recipient"]);
});

it.skipIf(process.platform === "win32")("keeps a recorded fix's command input separate from an existing input with the same name", async () => {
  const { api, root } = await fixture("fix", {
    id: "command", role: "bot", kind: "activity", tool: {
      name: "Bash", itemId: "command", ok: true, input: JSON.stringify({ command: `printf %s ${recordedEmail} > address.txt` }),
    },
  });
  const original = workflowSchema.parse({ version: 1, summary: "Write addresses", args: { email: { default: priorEmail } }, steps: [
    { id: "s1", kind: "file", label: "Existing", path: "existing.txt", content: { $arg: "email" } },
    { id: "s2", kind: "file", label: "Finish", path: "complete.txt", content: "done" },
  ] });
  expect((await api("/api/skill-burgers", { name: "addresses", workflow: original })).status).toBe(201);
  const changed = await api("/api/skill-burgers/addresses/fix", { runBotId: "lead", threadId: "t", run: "recorded-run", step: "s2" });
  expect(changed.status).toBe(200);
  const { workflow } = (await api("/api/skill-burgers/addresses")).body;
  const cwd = join(root, "replay");
  mkdirSync(cwd);
  const exec = createExecutors({ botId: "lead", cwd, internal: async () => { throw new Error("only local files are needed"); } });
  const result = await startRun({ name: "addresses", botId: "lead", threadId: "new", workflow, sha256: changed.body.skill.sha256 }, {
    exec, events: { started() {}, ended() {} }, save() { throw new Error("this workflow should not pause"); },
  });
  expect(result).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(cwd, "address.txt"), "utf8")).toBe(recordedEmail);
  expect(readFileSync(join(cwd, "existing.txt"), "utf8")).toBe(priorEmail);
});
