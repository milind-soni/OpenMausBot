import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { cloudComputerRpc } from "../cloud-computer-tools.ts";
import type { AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createSkillBurgerRoutes } from "./routes.ts";
import type { RunEnvelope } from "./runner.ts";
import { createSkillBurgerRuns, RESUME_PATH, RUN_PATH, type BurgerTurn } from "./runs.ts";
import { burgerTurn } from "./turn-host.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});

async function replay(where: "computer" | "browser" | "localComputer", options: { browserAvailable?: boolean; held?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "burger-browser-location-"));
  roots.push(root);
  const url = "https://example.com/dashboard";
  const tool = (id: string, name: string, input: unknown): RunMessage => ({
    id, role: "bot", kind: "activity", tool: { name, itemId: id, ok: true, input: JSON.stringify(input), output: "Done" },
  });
  const messages: RunMessage[] = [
    { id: "ask", role: "user", kind: "text", text: `Open ${url}, inspect the page and mark completion` },
    tool("open", `mcp__${where}__${where === "browser" ? "browser_navigate" : "open_url"}`, { url }),
    tool("click", `mcp__${where}__${where === "browser" ? "browser_click" : "click"}`, where === "browser" ? { ref: "button" } : { x: 100, y: 200 }),
    tool("finish", "Write", { file_path: "complete.txt", content: "finished" }),
  ];
  const routes = createSkillBurgerRoutes({ root, messages: () => messages, owns: () => true, sees: () => true, botIds: () => ["lead"] });
  let runs = createSkillBurgerRuns({ root, dataDir: root });
  let held = options.held ?? false;
  let gateCalls = 0;
  const sent: Array<{ kind: string; path: string; body: unknown }> = [];
  const commands: Array<{ path: string; command: string }> = [];
  const minted: string[] = [];
  let turn: BurgerTurn;
  const server = createServer(async (req, res) => {
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const kind = parsed.pathname === "/api/internal/computer/mcp" ? "computer" : parsed.pathname === "/api/internal/browser/mcp" ? "browser" : null;
    if (kind) {
      expect(req.headers.authorization).toBe(`Bearer ${kind}-fixture`);
      const body = await readBody(req) as Parameters<typeof cloudComputerRpc>[0];
      sent.push({ kind, path: parsed.pathname, body });
      const result = kind === "browser" ? { content: [{ type: "text", text: "Opened the built-in browser" }] } : await cloudComputerRpc(body, {
        cfg: { box: { token: "synthetic-cloud-key" } } as AppConfig,
        boxId: () => "bx_23456789", signal: new AbortController().signal, assertActive() {},
        gate: async () => { gateCalls++; return held ? { held: true, reason: "person" } : { held: false }; },
      });
      json(res, 200, { result });
      return;
    }
    if (parsed.pathname === "/sandboxes/bx_23456789/commands") {
      const body = await readBody(req) as { command: string };
      commands.push({ path: parsed.pathname, command: body.command });
      json(res, 200, { exitCode: 0, stdout: "", stderr: "" });
      return;
    }
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    if (!await dispatchRoutes([routes, runs.internalRoutes(turn)], { req, res, url: parsed, path: parsed.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  turn = burgerTurn({
    port, cwd: () => root, mayEditBurgers: () => true, publish() {},
    mint: (_turn, kind) => { minted.push(kind); return `${kind}-fixture`; },
    browser: async () => options.browserAvailable === false ? null : { env: { [harnessMcpTokenEnv("browser")]: "browser-fixture" } },
  }, { botId: "lead", threadId: "page", generation: "fixture-turn" }, "Bearer agents-fixture");
  vi.stubEnv("OMB_BOAT_API", base);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", undefined);
  const api = async <T>(path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return await response.json() as T;
  };
  const saved = await api<{ skill: { name: string } }>("/api/skill-burgers", { botId: "lead", threadId: "page", summary: "Inspect a page" });
  const read = await api<{ workflow: unknown }>(`/api/skill-burgers/${saved.skill.name}`);
  const workflow = workflowSchema.parse(read.workflow);
  return {
    root, workflow, sent, commands, minted, gateCalls: () => gateCalls, release: () => { held = false; },
    run: (args?: Record<string, unknown>) => api<RunEnvelope>(RUN_PATH, { name: saved.skill.name, args }),
    resume: (run: string, response: string) => {
      runs = createSkillBurgerRuns({ root, dataDir: root });
      return api<RunEnvelope>(RESUME_PATH, { run, response });
    },
  };
}

it.each([true, false])("opens the recorded cloud page before handing back its clicks, with built-in browser available=%s", async (browserAvailable) => {
  const h = await replay("computer", { browserAvailable });
  expect(h.workflow.steps[0]).toMatchObject({ kind: "browser", where: "vm" });
  const paused = await h.run();
  expect(paused).toMatchObject({ ok: true, status: "needs_input", requiresInput: { step: "s2", type: "ai_step" } });
  expect(paused.requiresInput?.prompt).toContain("cloud computer");
  expect(h.sent).toEqual([{ kind: "computer", path: "/api/internal/computer/mcp", body: expect.objectContaining({ params: { name: "open_url", arguments: { url: "https://example.com/dashboard" } } }) }]);
  expect(h.commands).toEqual([{ path: "/sandboxes/bx_23456789/commands", command: expect.stringContaining("xdg-open") }]);
  expect(h.commands[0]!.command).toContain("https://example.com/dashboard");
  expect(h.gateCalls()).toBe(1);
  expect(h.minted).toEqual(["computer"]);
  expect(existsSync(join(h.root, "complete.txt"))).toBe(false);
  expect(await h.resume(paused.run, "Inspected the page and finished its clicks")).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(h.root, "complete.txt"), "utf8")).toBe("finished");
  expect(h.commands).toHaveLength(1);
});

it("passes this run's URL input to the cloud page opener", async () => {
  const h = await replay("computer");
  const url = "https://example.com/another?name=it's&view=report";
  expect(await h.run({ url })).toMatchObject({ status: "needs_input", requiresInput: { step: "s2" } });
  expect(h.sent[0]).toMatchObject({ kind: "computer", body: { params: { name: "open_url", arguments: { url } } } });
  expect(h.commands).toHaveLength(1);
});

it("keeps built-in browser navigation on its own route", async () => {
  const h = await replay("browser");
  expect(await h.run()).toMatchObject({ status: "needs_input", requiresInput: { step: "s2" } });
  expect(h.sent).toEqual([{ kind: "browser", path: "/api/internal/browser/mcp", body: expect.objectContaining({ params: { name: "agent_browser_open", arguments: { url: "https://example.com/dashboard" } } }) }]);
  expect(h.commands).toEqual([]);
  expect(h.gateCalls()).toBe(0);
  expect(h.minted).toEqual([]);
});

it("leaves the person's own computer to the existing manual handoff", async () => {
  const h = await replay("localComputer");
  const paused = await h.run();
  expect(paused).toMatchObject({ status: "needs_input", requiresInput: { step: "s1", type: "ai_step" } });
  expect(paused.requiresInput?.prompt).toContain("person's own computer");
  expect(h.sent).toEqual([]);
  expect(h.commands).toEqual([]);
  expect(existsSync(join(h.root, "complete.txt"))).toBe(false);
});

it("stops at the cloud control gate and resumes there after the person releases it", async () => {
  const h = await replay("computer", { held: true });
  const refused = await h.run();
  expect(refused).toMatchObject({ ok: false, error: { type: "step_failed", step: "s1", message: expect.stringContaining("taken control") } });
  expect(h.sent.map(({ kind }) => kind)).toEqual(["computer"]);
  expect(h.commands).toEqual([]);
  expect(existsSync(join(h.root, "complete.txt"))).toBe(false);
  h.release();
  const paused = await h.resume(refused.run, "The person released the cloud computer");
  expect(paused).toMatchObject({ ok: true, status: "needs_input", requiresInput: { step: "s2" } });
  expect(h.commands).toHaveLength(1);
  expect(await h.resume(paused.run, "Inspected the page")).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(h.root, "complete.txt"), "utf8")).toBe("finished");
});
