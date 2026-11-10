import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkflowStore } from "./store.ts";
import { createMinimumAiRoutes } from "./routes.ts";
import type { RouteContext } from "../routes/table.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("requires an owner, explicit successful test and matching revision before approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-routes-")); dirs.push(dir);
  const store = createWorkflowStore(join(dir, "plans.json"));
  const binding = { owner: "owner", botId: "bot", prompt: "Read inbox", connectionIds: ["mail-1"] };
  const invoke = vi.fn(async () => ({ messages: [] }));
  const context = vi.fn(async (auth: { kind: string }) => auth.kind === "session" ? {
    binding, catalog: [{ name: "MAIL_LIST", inputSchema: { type: "object" } }], invoke,
    planner: async () => ({ version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }),
  } : null);
  const route = createMinimumAiRoutes({ store, context: context as never });
  async function request(action: string, body: unknown = {}, kind = "session") {
    let response: { status: number; body: any } | undefined;
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writableEnded: false });
    await route({ path: `/api/routines/routine-1/minimum-ai${action ? `/${action}` : ""}`, method: action ? "POST" : "GET", auth: { kind }, res,
      readBody: async () => body, json: (_res: unknown, status: number, data: unknown) => { response = { status, body: data }; } } as unknown as RouteContext);
    return response!;
  }
  expect((await request("prepare", {}, "other")).status).toBe(404);
  const draft = (await request("prepare")).body.workflow;
  expect(invoke).not.toHaveBeenCalled();
  expect((await request("approve", { fingerprint: draft.fingerprint })).status).toBe(400);
  expect((await request("test", { fingerprint: draft.fingerprint })).body.result.status).toBe("completed");
  expect((await request("approve", { fingerprint: draft.fingerprint })).body.workflow.approved).toBe(true);
  binding.prompt = "Delete inbox";
  expect((await request("")).status).toBe(400);
});

it("holds a partly failed first test until the owner acknowledges it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-route-hold-")); dirs.push(dir);
  const store = createWorkflowStore(join(dir, "plans.json"));
  const binding = { owner: "owner", botId: "bot", prompt: "Read inbox", connectionIds: ["mail-1"] };
  let held = false;
  const route = createMinimumAiRoutes({ store, interrupted: () => held, hold: () => { held = true; }, acknowledge: () => { held = false; }, context: async () => ({ binding, catalog: [{ name: "MAIL_LIST", inputSchema: { type: "object" } }], invoke: async () => { throw new Error("Connection lost"); }, planner: async () => ({ version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }) }) });
  async function request(action: string, body: unknown = {}) {
    let response: { status: number; body: any } | undefined;
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writableEnded: false });
    await route({ path: `/api/routines/routine-1/minimum-ai/${action}`, method: "POST", auth: { kind: "session" }, res,
      readBody: async () => body, json: (_res: unknown, status: number, data: unknown) => { response = { status, body: data }; } } as unknown as RouteContext);
    return response!;
  }
  const draft = (await request("prepare")).body.workflow;
  const failed = await request("test", { fingerprint: draft.fingerprint });
  expect(failed.body).toMatchObject({ interrupted: true, result: { status: "failed", partial: true } });
  expect((await request("test", { fingerprint: draft.fingerprint })).status).toBe(409);
  expect((await request("acknowledge", {})).status).toBe(400);
  expect((await request("acknowledge", { confirm: true })).body.interrupted).toBe(false);
});

it("stops and holds a first test when a connected tool does not respond", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-test-timeout-")); dirs.push(dir);
  const store = createWorkflowStore(join(dir, "plans.json"));
  const binding = { owner: "owner", botId: "bot", prompt: "Read inbox", connectionIds: ["mail-1"] };
  let held = false;
  const invoke = vi.fn(async (_tool: string, _input: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Tool timed out")), { once: true })));
  const route = createMinimumAiRoutes({ store, testTimeoutMs: 25, interrupted: () => held, hold: () => { held = true; }, context: async () => ({ binding, catalog: [{ name: "MAIL_LIST", inputSchema: { type: "object" } }], invoke, planner: async () => ({ version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }) }) });
  async function request(action: string, body: unknown = {}) {
    let response: { status: number; body: any } | undefined;
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writableEnded: false });
    await route({ path: `/api/routines/routine-1/minimum-ai/${action}`, method: "POST", auth: { kind: "session" }, res, readBody: async () => body, json: (_res: unknown, status: number, data: unknown) => { response = { status, body: data }; } } as unknown as RouteContext);
    return response!;
  }
  const draft = (await request("prepare")).body.workflow;
  expect((await request("test", { fingerprint: draft.fingerprint })).body).toMatchObject({ interrupted: true, result: { status: "failed", partial: true } });
  expect(invoke).toHaveBeenCalledOnce();
});

it("lets only the owner acknowledge an interrupted run even while its account is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-disconnected-")); dirs.push(dir);
  const store = createWorkflowStore(join(dir, "plans.json"));
  let held = true;
  const route = createMinimumAiRoutes({ store, authorizeRecovery: (auth) => auth.kind === "session", interrupted: () => held, acknowledge: () => { held = false; }, context: async () => { throw new Error("Account unavailable"); } });
  async function request(action: string, kind: string, body: unknown = {}) {
    let response: { status: number; body: any } | undefined;
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writableEnded: false });
    await route({ path: `/api/routines/routine-1/minimum-ai/${action}`, method: action === "recovery" ? "GET" : "POST", auth: { kind }, res, readBody: async () => body, json: (_res: unknown, status: number, data: unknown) => { response = { status, body: data }; } } as unknown as RouteContext);
    return response!;
  }
  expect((await request("recovery", "other")).status).toBe(404);
  expect((await request("acknowledge", "other", { confirm: true })).status).toBe(404);
  expect((await request("recovery", "session")).body.interrupted).toBe(true);
  expect((await request("acknowledge", "session", { confirm: true })).body).toMatchObject({ workflow: null, interrupted: false });
});
