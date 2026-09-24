import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendTurnInput } from "../contracts.ts";

const jpeg = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==";
let server: Server;
let origin: string;
let mount: typeof import("./chat-mcp-tools.ts").mountChatTools;
let state: Record<string, unknown>;
let controlStatus: number;
let holdCommand = false;
let commandStarted: (() => void) | undefined;
const calls: Array<{ path: string; body: any; authorization?: string }> = [];
let integrations: SendTurnInput["integrations"];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const path = req.url ?? "";
    calls.push({ path, body: body ? JSON.parse(body) : null, authorization: req.headers.authorization });
    if (path === "/control") { res.writeHead(controlStatus); res.end(JSON.stringify(state)); return; }
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
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("OMB_BOX_API", origin);
  mount = (await import("./chat-mcp-tools.ts")).mountChatTools;
  integrations = { computer: { kind: "box", boxId: "bx_23456789", token: "synthetic-box-key", control: { url: origin + "/control", token: "synthetic-control-key" } } };
});
beforeEach(() => { calls.length = 0; state = { held: false, helpOpen: false }; controlStatus = 200; holdCommand = false; commandStarted = undefined; });
afterAll(async () => { vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

describe("chat Box bridge", () => {
  it("mounts only with computer support and a leased control gate", async () => {
    const signal = new AbortController().signal;
    const disabled = await mount(integrations, signal);
    expect(disabled.definitions).toHaveLength(0);
    await disabled.close();
    await expect(mount({ computer: { boxId: "bx_23456789", token: "synthetic-box-key" } }, signal, true)).rejects.toThrow("control gate missing");
    expect(calls).toHaveLength(0);
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
  ] as const)("executes validated %s on the assigned Box only", async (name, args, expected) => {
    const signal = new AbortController().signal;
    const session = await mount(integrations, signal, true);
    try {
      const result = await session.execute("computer_" + name, args, signal);
      expect(result.ok).toBe(true);
      if (name === "open_url") expect(result.text).toContain("Page loading is not confirmed");
      expect(calls.map(call => call.path)).toEqual(["/control", "/boxes/bx_23456789/commands"]);
      expect(calls[0].authorization).toBe("Bearer synthetic-control-key");
      expect(calls[1].authorization).toBe("Bearer synthetic-box-key");
      expect(calls[1].body.command).toContain("exec env -i");
      expect(calls[1].body.command).toContain(expected);
      expect(calls[1].body.command).not.toContain("synthetic-box-key");
    } finally { await session.close(); }
  });

  it("returns structured screenshots without resizing or racing panel capture paths", async () => {
    const signal = new AbortController().signal;
    const session = await mount(integrations, signal, true);
    try {
      const result = await session.execute("computer_screenshot", {}, signal);
      expect(result.images).toEqual([{ type: "image_url", image_url: { url: "data:image/jpeg;base64," + Buffer.from(jpeg, "base64").toString("base64") } }]);
      expect(calls[1].body.command).toContain("ogb-panel.jpg.model.jpg");
      expect(calls[1].body.command).not.toContain("-resize");
      expect(calls[2].path).toContain("ogb-panel.jpg.model.jpg");
    } finally { await session.close(); }
  });

  it.each(["held", "expired", "owner-changed"])("performs no remote action when %s", async mode => {
    if (mode === "held") state.held = true;
    if (mode === "expired") controlStatus = 401;
    if (mode === "owner-changed") state.blockedReason = "Another thread owns the computer";
    const signal = new AbortController().signal;
    const session = await mount(integrations, signal, true);
    try {
      expect((await session.execute("computer_click", { x: 3, y: 4 }, signal)).ok).toBe(false);
      expect(calls.map(call => call.path)).toEqual(["/control"]);
    } finally { await session.close(); }
  });

  it("rejects invalid arguments before any control or Box request", async () => {
    const signal = new AbortController().signal;
    const session = await mount(integrations, signal, true);
    try {
      await expect(session.execute("computer_click", { x: "1; touch marker", y: 4 }, signal)).rejects.toThrow("input schema");
      await expect(session.execute("computer_open_url", { url: "file:///etc/passwd" }, signal)).rejects.toThrow("input schema");
      expect(calls).toHaveLength(0);
    } finally { await session.close(); }
  });

  it("aborts an in-flight Box operation and closes the session without retrying", async () => {
    holdCommand = true;
    const started = new Promise<void>(resolve => { commandStarted = resolve; });
    const abort = new AbortController();
    const session = await mount(integrations, abort.signal, true);
    const running = session.execute("computer_exec", { command: "printf fixture" }, abort.signal);
    const rejected = expect(running).rejects.toThrow();
    await started;
    abort.abort();
    await rejected;
    await expect(session.execute("computer_screenshot", {}, new AbortController().signal)).rejects.toThrow("closed");
    expect(calls.filter(call => call.path.endsWith("/commands"))).toHaveLength(1);
    await session.close();
    server.closeAllConnections();
  });
});
