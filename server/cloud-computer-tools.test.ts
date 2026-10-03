// The cloud computer's tools as the harness serves them to every engine with
// computer tools (POST /api/internal/computer/mcp). A loopback Boat stands in
// for the provider; the server's own account is the only credential used.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";

const jpeg = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==";
let server: Server;
let tools: typeof import("./cloud-computer-tools.ts");
let holdCommand = false;
let commandStarted: (() => void) | undefined;
const calls: Array<{ path: string; body: any; authorization?: string }> = [];
const cfg: AppConfig = { box: { token: "synthetic-box-key" } } as AppConfig;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const path = req.url ?? "";
    calls.push({ path, body: body ? JSON.parse(body) : null, authorization: req.headers.authorization });
    if (path.endsWith("/commands")) {
      commandStarted?.();
      if (!holdCommand) res.end(JSON.stringify({ exitCode: 0, stdout: "captured", stderr: "" }));
      return;
    }
    if (path.includes("/artifacts?")) { res.end(Buffer.from(jpeg, "base64")); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", undefined);
  tools = await import("./cloud-computer-tools.ts");
});
beforeEach(() => { calls.length = 0; holdCommand = false; commandStarted = undefined; });
afterAll(async () => { vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

const rpc = (request: unknown, gate: { held: boolean; blockedReason?: string } = { held: false }, signal = new AbortController().signal) => {
  let gated = 0;
  let checks = 0;
  const done = tools.cloudComputerRpc(request as never, {
    cfg, boxId: "bx_23456789", signal,
    gate: async () => { gated++; return gate; },
    assertActive: () => { checks++; },
  });
  return { done, gated: () => gated, checks: () => checks };
};

describe("cloud computer tools", () => {
  it("lists the same ten tools for every engine", async () => {
    const listed = await rpc({ method: "tools/list", params: {} }).done as { tools: Array<{ name: string }> };
    expect(listed.tools.map(tool => tool.name)).toEqual([
      "screenshot", "get_screen_size", "click", "move", "drag", "type_text", "key_press", "scroll", "open_url", "exec",
    ]);
    expect(calls).toEqual([]);
  });

  it.each([
    ["click", { x: 3, y: 4, button: "right", count: 2 }, "click --repeat 2 --delay 100 3"],
    ["move", { x: 7, y: 8 }, "mousemove --sync 7 8"],
    ["drag", { x: 1, y: 2, to_x: 3, to_y: 4 }, "mousedown 1 mousemove --sync 3 4 mouseup 1"],
    ["scroll", { x: 4, y: 3, direction: "down", amount: 2 }, "click --repeat 2 --delay 80 5"],
    ["key_press", { key: "ctrl+l" }, "key --clearmodifiers"],
    ["type_text", { text: "Unicode: 日本語 ' $(echo unsafe)" }, "base64 -d | xclip"],
    ["open_url", { url: "https://example.com/?a='&b=2" }, "xdg-open"],
    ["exec", { command: "printf hello" }, "printf hello"],
    ["get_screen_size", {}, "getdisplaygeometry"],
  ] as const)("runs %s on the assigned Boat only, with the server's own account", async (name, args, expected) => {
    const call = rpc({ method: "tools/call", params: { name, arguments: args } });
    const result = await call.done as { isError?: boolean; content: Array<{ text?: string }> };
    expect(result.isError).not.toBe(true);
    if (name === "open_url") expect(result.content[0].text).toContain("Page loading is not confirmed");
    expect(call.gated()).toBe(1);
    expect(call.checks()).toBe(2);
    expect(calls.map(entry => entry.path)).toEqual(["/boxes/bx_23456789/commands"]);
    expect(calls[0].authorization).toBe("Bearer synthetic-box-key");
    expect(calls[0].body.command).toContain("exec env -i");
    expect(calls[0].body.command).toContain(expected);
    expect(calls[0].body.command).not.toContain("synthetic-box-key");
    if (name === "type_text") expect(calls[0].body.command).not.toContain("$(echo unsafe)");
  });

  it("returns native-size screenshots as MCP images", async () => {
    const result = await rpc({ method: "tools/call", params: { name: "screenshot", arguments: {} } }).done;
    expect(result).toEqual({ content: [{ type: "image", mimeType: "image/jpeg", data: Buffer.from(jpeg, "base64").toString("base64") }] });
    expect(calls[0].body.command).toContain("ogb-panel.jpg.model.jpg");
    expect(calls[0].body.command).not.toContain("-resize");
    expect(calls[1].path).toContain("ogb-panel.jpg.model.jpg");
  });

  it.each([
    ["a shell fragment in a coordinate", "click", { x: "1; touch marker", y: 4 }],
    ["a file URL", "open_url", { url: "file:///etc/passwd" }],
    ["an extra field", "move", { x: 1, y: 2, after: "rm -rf /" }],
    ["a key with shell syntax", "key_press", { key: "a; reboot" }],
    ["an unknown tool", "computer_exec", { command: "true" }],
    ["non-object arguments", "exec", "true"],
  ])("refuses %s before the control gate or the Boat", async (_label, name, args) => {
    const call = rpc({ method: "tools/call", params: { name, arguments: args } });
    const result = await call.done as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/input schema|Unknown cloud computer tool/);
    expect(call.gated()).toBe(0);
    expect(calls).toHaveLength(0);
    // The direct entry point refuses the same calls on its own.
    await expect(tools.runCloudComputerTool(cfg, "bx_23456789", name, args as never, new AbortController().signal))
      .resolves.toMatchObject({ isError: true });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a person holds control", { held: true }, "NOT performed"],
    ["another thread owns the seat", { held: true, blockedReason: "Another thread is using this computer." }, "Another thread is using this computer."],
  ])("performs nothing on the Boat when %s", async (_label, gate, text) => {
    const call = rpc({ method: "tools/call", params: { name: "click", arguments: { x: 3, y: 4 } } }, gate);
    const result = await call.done as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(text);
    expect(calls).toHaveLength(0);
  });

  it("stops when the turn's capability is gone, before and after the Boat acts", async () => {
    const expired = () => { throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 }); };
    await expect(tools.cloudComputerRpc({ method: "tools/list" }, {
      cfg, boxId: "bx_23456789", signal: new AbortController().signal, gate: async () => ({ held: false }), assertActive: expired,
    })).rejects.toThrow("expired");
    await expect(tools.cloudComputerRpc({ method: "tools/call", params: { name: "exec", arguments: { command: "true" } } }, {
      cfg, boxId: "bx_23456789", signal: new AbortController().signal, gate: async () => ({ held: false }), assertActive: expired,
    })).rejects.toThrow("expired");
    expect(calls).toHaveLength(0);
    await expect(rpc({ method: "resources/read" }).done).rejects.toMatchObject({ status: 400 });
  });

  it("aborts an in-flight Boat command without retrying it", async () => {
    holdCommand = true;
    const started = new Promise<void>(resolve => { commandStarted = resolve; });
    const abort = new AbortController();
    const running = rpc({ method: "tools/call", params: { name: "exec", arguments: { command: "printf fixture" } } }, { held: false }, abort.signal).done;
    const rejected = expect(running).rejects.toThrow();
    await started;
    abort.abort();
    await rejected;
    expect(calls.filter(entry => entry.path.endsWith("/commands"))).toHaveLength(1);
    server.closeAllConnections();
  });
});
