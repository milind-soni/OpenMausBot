import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pure provider fixture: no environment identity, live account, or paid machine
// is read or created by this test suite.
vi.mock("./config.ts", () => ({ DATA_DIR: "/unused-orgo-fixture" }));
vi.mock("./environment.ts", () => ({ loadEnvironmentId: () => "714e2384-32c6-4b18-852e-32e429a2deab" }));
import * as orgo from "./orgo.ts";
import type { AppConfig } from "./config.ts";

const workspaceId = "550e8400-e29b-41d4-a716-446655440000";
const computerId = "a3bb189e-8bf9-4888-9912-ace4e6543002";
const operationId = "b3bb189e-8bf9-4888-9912-ace4e6543002";
const name = orgo.orgoComputerName("fixture-bot");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=";
const cfg = () => ({ orgo: { apiKey: "sk_fixture_secret", workspaceId } } satisfies AppConfig);
const lease = () => ({ apiKey: "sk_fixture_secret", workspaceId, computerId, computerName: name });
type Request = { url: URL; method: string; body?: Record<string, unknown>; token: string };
const requests: Request[] = [];
let machine: Record<string, unknown> | null;
let mutate: ((request: Request) => Response | undefined) | undefined;
let nextExit: number;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function record(status = "running"): Record<string, unknown> {
  return { id: computerId, name, project_id: workspaceId, status, os: "linux", permissions: { canView: true, canWrite: true }, fly_instance_id: "a3881618", vnc_password: "private-vnc-secret" };
}
beforeEach(() => {
  requests.length = 0; machine = record(); mutate = undefined; nextExit = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request: Request = { url: new URL(String(input)), method: init?.method ?? "GET", token: new Headers(init?.headers).get("authorization") ?? "", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    expect(request.url.origin).toBe("https://www.orgo.ai");
    expect(init?.redirect).toBe("error");
    requests.push(request);
    const overridden = mutate?.(request);
    if (overridden) return overridden;
    const path = request.url.pathname;
    if (path === "/api/workspaces") return json({ workspaces: [{ id: workspaceId, name: "Fixture workspace", desktops: machine ? [{ id: computerId, name }] : [] }], projects: [{ api_key: "not-for-ui" }] });
    if (path === "/api/computers" && request.method === "POST") { machine = record(); return json({ ...machine, workspace_id: workspaceId }, 201); }
    if (path === `/api/computers/${computerId}`) {
      if (request.method === "DELETE") { machine = null; return json({ success: true }); }
      return machine ? json(machine) : json({ error: "Desktop not found" }, 404);
    }
    if (path.endsWith("/proxy/health")) return json({ status: "ok" });
    if (path.endsWith("/start")) { machine = record(); return json({ success: true }); }
    if (path.endsWith("/stop")) { machine = record("frozen"); return json({ success: true }); }
    if (path.endsWith("/restart")) { machine = { ...record(), vnc_password: "rotated-vnc-secret" }; return json({ success: true }); }
    if (path.endsWith("/screenshot")) return json({ success: true, image: png, mime_type: "image/png", width: 1, height: 1 });
    if (path.endsWith("/bash")) return json({ success: true, output: "fixture output", exit_code: nextExit, error: null });
    return json({ success: true });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Orgo BYOK computer adapter", () => {
  it("needs an explicit workspace and returns only safe catalog fields", async () => {
    const keyOnly = { orgo: { apiKey: "sk_fixture_secret" } };
    expect(orgo.isConfigured(keyOnly)).toBe(false);
    await expect(orgo.provision(keyOnly, "fixture-bot")).rejects.toThrow("Choose an Orgo workspace");
    expect(requests).toHaveLength(0);
    expect(await orgo.listWorkspaces(keyOnly)).toEqual([{ id: workspaceId, name: "Fixture workspace" }]);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("uses durable environment/bot identity, not a bot label or short-id prefix", () => {
    expect(orgo.orgoComputerName("fixture-bot")).toBe(name);
    expect(orgo.orgoComputerName("fixture-other")).not.toBe(name);
    expect(name).toMatch(/^openmausbot-orgo-[0-9a-f]{12}-[0-9a-f]{24}$/);
  });
  it("status and screenshots never create or wake a missing computer", async () => {
    machine = null;
    expect(await orgo.state(cfg(), "fixture-bot")).toMatchObject({ configured: true, container: "missing", ready: false, box: null });
    await expect(orgo.screenshot(cfg(), "fixture-bot")).rejects.toThrow("no Orgo computer");
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("keeps status, catalog and lifecycle responses free of account/viewer secrets", async () => {
    const status = await orgo.state(cfg(), "fixture-bot");
    expect(status).toMatchObject({ configured: true, container: "running", ready: true, managed: true, box: { id: computerId, name, state: "running" } });
    const result = await orgo.provision(cfg(), "fixture-bot");
    expect(result).toMatchObject({ boxId: computerId, machineName: name, reused: true });
    expect(JSON.stringify([status, result])).not.toMatch(/sk_fixture|vnc|private/);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
  it("creates one Linux computer only after explicit provision and checks readiness", async () => {
    machine = null;
    expect(await orgo.provision(cfg(), "fixture-bot")).toMatchObject({ boxId: computerId, reused: false, state: "running" });
    expect(requests.filter((r) => r.method === "POST")).toEqual([expect.objectContaining({ body: { workspace_id: workspaceId, name, os: "linux", ram: 4, cpu: 1 } })]);
    expect(requests.at(-1)?.token).toBe("Bearer private-vnc-secret");
  });
  it("accepts a documented HTTP 200 readiness response without requiring JSON", async () => {
    mutate = (r) => r.url.pathname.endsWith("/proxy/health") ? new Response("healthy", { status: 200 }) : undefined;
    expect(await orgo.provision(cfg(), "fixture-bot")).toMatchObject({ ready: true, configured: true, container: "running" });
  });
  it("adopts a name collision only after exact name/workspace/id ownership verification", async () => {
    machine = null;
    mutate = (r) => {
      if (r.url.pathname === "/api/computers" && r.method === "POST") { machine = record(); return json({ code: "NAME_TAKEN", error: "name collision" }, 409); }
    };
    expect(await orgo.provision(cfg(), "fixture-bot")).toMatchObject({ reused: true });
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    machine = null;
    mutate = (r) => r.method === "POST" ? json({ code: "quota", error: "Cannot create" }, 409) : undefined;
    await expect(orgo.provision(cfg(), "fixture-bot")).rejects.toThrow("Cannot create");
  });
  it("does not retry uncertain create/action outcomes or replace a stale inventory 404", async () => {
    mutate = (r) => r.url.pathname === `/api/computers/${computerId}` ? json({ error: "Desktop not found" }, 404) : undefined;
    await expect(orgo.provision(cfg(), "fixture-bot")).rejects.toThrow("HTTP 404");
    expect(requests.some((r) => r.method === "POST")).toBe(false);
    requests.length = 0; machine = null;
    mutate = (r) => r.method === "POST" ? json({ error: "uncertain create" }, 503) : undefined;
    await expect(orgo.provision(cfg(), "fixture-bot")).rejects.toThrow("uncertain create");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
  it.each([
    ["different name", { name: "someone-elses-computer" }],
    ["different workspace", { project_id: "650e8400-e29b-41d4-a716-446655440000" }],
    ["different identity", { id: "b3bb189e-8bf9-4888-9912-ace4e6543002" }],
    ["non-Linux computer", { os: "macos" }],
    ["read-only access", { permissions: { canWrite: false } }],
  ])("refuses %s before any mutation", async (_description, changes) => {
    machine = { ...record(), ...changes };
    await expect(orgo.sleep(cfg(), "fixture-bot")).rejects.toThrow();
    expect(requests.some((r) => r.method !== "GET")).toBe(false);
  });
  it("starts stopped computers, adopts resumable suspended ones, and refreshes restart credentials", async () => {
    machine = record("frozen");
    expect(await orgo.wake(cfg(), "fixture-bot")).toMatchObject({ state: "running" });
    expect(requests.find((r) => r.method === "POST")?.url.search).toBe("?async=true");
    requests.length = 0; machine = record("suspended");
    expect(await orgo.wake(cfg(), "fixture-bot")).toMatchObject({ state: "suspended" });
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(await orgo.restart(cfg(), "fixture-bot")).toMatchObject({ state: "running" });
    expect((await orgo.computer(cfg(), "fixture-bot"))?.vnc_password).toBe("rotated-vnc-secret");
  });
  it("polls async operations at a constructed same-origin path, ignoring poll_url", async () => {
    machine = record("frozen");
    mutate = (r) => {
      if (r.url.pathname.endsWith("/start")) { machine = record(); return json({ operation_id: operationId, poll_url: "https://evil.example/collect-key" }, 202); }
      if (r.url.pathname.endsWith(`/operations/${operationId}`)) return json({ id: operationId, desktop_id: computerId, status: "succeeded" });
    };
    expect(await orgo.wake(cfg(), "fixture-bot")).toMatchObject({ state: "running" });
    expect(requests.some((r) => r.url.pathname.endsWith(`/operations/${operationId}`))).toBe(true);
  });
  it("does not retry a lifecycle operation with an uncertain needs_review result", async () => {
    machine = record("frozen");
    mutate = (r) => {
      if (r.url.pathname.endsWith("/start")) return json({ operation_id: operationId }, 202);
      if (r.url.pathname.endsWith(`/operations/${operationId}`)) return json({ id: operationId, desktop_id: computerId, status: "needs_review" });
    };
    await expect(orgo.wake(cfg(), "fixture-bot")).rejects.toThrow("Check the computer in Orgo");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
  it("bounds lifecycle readiness without repeating an already-started operation", async () => {
    machine = record("frozen");
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(300_001);
    await expect(orgo.wake(cfg(), "fixture-bot")).rejects.toThrow("still opening");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(orgo.orgoLifecycleBusy()).toBe(false);
  });
  it("stops with archived files and confirms deletion before reporting success", async () => {
    expect(await orgo.sleep(cfg(), "fixture-bot")).toMatchObject({ state: "frozen" });
    expect(await orgo.remove(cfg(), "fixture-bot")).toEqual({ removed: true });
    expect(machine).toBeNull();
    machine = record();
    mutate = (r) => r.method === "DELETE" ? json({ success: true }) : undefined;
    await expect(orgo.remove(cfg(), "fixture-bot")).rejects.toThrow("deletion has not completed");
  });
  it("snapshots credentials across the whole lifecycle operation", async () => {
    const changing = cfg();
    mutate = (r) => { if (r.url.pathname === "/api/workspaces") changing.orgo.apiKey = "sk_new_account"; return undefined; };
    await orgo.sleep(changing, "fixture-bot");
    expect(requests.every((r) => r.token === "Bearer sk_fixture_secret")).toBe(true);
  });
  it("inspects only exact environment-owned records and refuses key rotation losing access", async () => {
    expect(await orgo.inspectOwned(cfg())).toEqual([{ boxId: computerId, name }]);
    await expect(orgo.validateReplacement(cfg(), { orgo: { workspaceId } })).rejects.toThrow("before disconnecting");
    mutate = (r) => r.token === "Bearer sk_new_account" ? json({ workspaces: [{ id: workspaceId, name: "Other account", desktops: [] }] }) : undefined;
    await expect(orgo.validateReplacement(cfg(), { orgo: { workspaceId, apiKey: "sk_new_account" } })).rejects.toThrow("cannot manage");
  });
  it("does not orphan owned computers when the selected workspace changes with the same key", async () => {
    await expect(orgo.validateReplacement(cfg(), { orgo: { apiKey: "sk_fixture_secret", workspaceId: "650e8400-e29b-41d4-a716-446655440000" } })).rejects.toThrow("before changing");
    await expect(orgo.validateReplacement(cfg(), { orgo: { apiKey: "sk_fixture_secret" } })).rejects.toThrow("before changing");
    await expect(orgo.validateReplacement(cfg(), cfg())).resolves.toBeUndefined();
    machine = null;
    await expect(orgo.validateReplacement(cfg(), { orgo: { apiKey: "sk_fixture_secret", workspaceId: "650e8400-e29b-41d4-a716-446655440000" } })).resolves.toBeUndefined();
  });
  it("launches a remote linux MCP with secrets only in its environment", async () => {
    const descriptor = await orgo.mcp(cfg(), "fixture-bot");
    expect(descriptor.platform).toBe("linux");
    expect(descriptor).not.toHaveProperty("scope");
    expect(descriptor.args.join(" ")).not.toMatch(/sk_fixture|private-vnc/);
    expect(descriptor.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1", ORGO_API_KEY: "sk_fixture_secret", ORGO_COMPUTER_ID: computerId, ORGO_COMPUTER_NAME: name });
  });
  it("uses inline native PNG screenshots, never fetches storage/provider URLs", async () => {
    expect(await orgo.screenshot(cfg(), "fixture-bot")).toEqual({ png, format: "png" });
    const r = requests.at(-1)!;
    expect(r.url.searchParams.get("response_format")).toBe("base64");
    expect(r.url.searchParams.get("format")).toBe("png");
    mutate = (request) => request.url.pathname.endsWith("/screenshot") ? json({ success: true, mime_type: "image/png", image: "https://evil.example/image" }) : undefined;
    await expect(orgo.screenshot(cfg(), "fixture-bot")).rejects.toThrow("invalid screenshot");
  });
  it.each([
    ["click", { x: "10", y: 5 }], ["click", { x: -1, y: 5 }], ["move", {}],
    ["exec", { command: "true", extra: "unexpected" }], ["key_press", { key: "Return; rm" }],
    ["scroll", { direction: "down" }], ["open_url", { url: "file:///etc/passwd" }], ["unknown", {}],
  ])("fails closed for malformed %s arguments", async (tool, args) => {
    await expect(orgo.leasedComputerAction(lease(), tool, args)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it("translates pointer/Unicode/X11 actions and Bash runs on DISPLAY=:99", async () => {
    await orgo.leasedComputerAction(lease(), "click", { x: 10, y: 20, count: 3, button: "right" });
    expect(requests.at(-1)?.body).toEqual({ x: 10, y: 20, repeat: 3, button: "right" });
    await orgo.leasedComputerAction(lease(), "drag", { x: 1, y: 2, to_x: 3, to_y: 4 });
    expect(requests.at(-1)?.body).toEqual({ start_x: 1, start_y: 2, end_x: 3, end_y: 4 });
    await orgo.leasedComputerAction(lease(), "type_text", { text: "日本語 👋" });
    expect(requests.at(-1)?.body).toEqual({ text: "日本語 👋", delay_ms: 1 });
    await orgo.leasedComputerAction(lease(), "exec", { command: "printf hi" });
    expect(requests.at(-1)?.body).toEqual({ command: "export DISPLAY=:99; printf hi", timeout: 200 });
  });
  it("reports nonzero command exits as failures even if Orgo success is true", async () => {
    nextExit = 42;
    const result = await orgo.leasedComputerAction(lease(), "exec", { command: "exit 42" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"exitCode":42') });
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
  it("redacts account and viewer credentials in provider errors and command output", async () => {
    mutate = (r) => r.url.pathname.endsWith("/bash") ? json({ success: true, exit_code: 0, output: "sk_fixture_secret private-vnc-secret" }) : undefined;
    expect(JSON.stringify(await orgo.leasedComputerAction(lease(), "exec", { command: "echo hi" }))).not.toMatch(/sk_fixture_secret|private-vnc-secret/);
    mutate = () => json({ error: "Invalid sk_fixture_secret Bearer sk_fixture_secret" }, 401);
    await expect(orgo.state(cfg(), "fixture-bot")).rejects.toThrow("[redacted]");
  });
});
