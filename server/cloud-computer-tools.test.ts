// A loopback Boat stands in for the provider; the server's own account is the only credential used.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";

const jpeg = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==";
let server: Server;
let tools: typeof import("./cloud-computer-tools.ts");
let holdCommand = false;
let commandStatus = 200;
let commandExit = 0;
/** This many commands in a row get the gateway's 502 before the machine answers again. */
let unansweredFirst = 0;
/** The Boat starts a detached command whose text says `forever` and reports it running until it is stopped; any other one has ended by the first read. */
let neverEnds = false;
const forever = new Set<number>();
let nextProcess = 100;
let commandStarted: (() => void) | undefined;
const calls: Array<{ path: string; body: any; authorization?: string }> = [];
const cfg: AppConfig = { box: { token: "synthetic-box-key" } } as AppConfig;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    // Every answer closes its connection: the tests that leave a command hanging close the server's sockets, and a pooled
    // keep-alive socket reused after that fails the next test's request with "other side closed".
    res.setHeader("connection", "close");
    let body = "";
    for await (const part of req) body += part;
    const path = req.url ?? "";
    calls.push({ path, body: body ? JSON.parse(body) : null, authorization: req.headers.authorization });
    const read = /\/commands\/(\d+)\?/.exec(path);
    if (neverEnds && read) {
      res.end(JSON.stringify(forever.has(Number(read[1])) ? { running: true, status: "running", stdout: "compiling", stderr: "" } : { running: false, status: "exited", exitCode: 0, stdout: "captured", stderr: "" }));
      return;
    }
    if (neverEnds && path.endsWith("/commands") && JSON.parse(body).detached === true) {
      const id = nextProcess++;
      if (String(JSON.parse(body).command).includes("forever")) forever.add(id);
      res.end(JSON.stringify({ processId: id }));
      return;
    }
    if (path.endsWith("/commands")) {
      commandStarted?.();
      if (unansweredFirst > 0) { unansweredFirst--; res.writeHead(502); res.end(JSON.stringify({ ok: false, code: "upstream_unavailable" })); return; }
      if (commandStatus !== 200) { res.writeHead(commandStatus); res.end(JSON.stringify({ ok: false, code: "upstream_unavailable" })); return; }
      if (!holdCommand) res.end(JSON.stringify({ exitCode: commandExit, stdout: "captured", stderr: "" }));
      return;
    }
    if (path.includes("/artifacts?")) { res.end(Buffer.from(jpeg, "base64")); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  vi.stubEnv("OMB_BOAT_API", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", undefined);
  tools = await import("./cloud-computer-tools.ts");
});
beforeEach(() => { calls.length = 0; holdCommand = false; commandStarted = undefined; commandStatus = 200; commandExit = 0; unansweredFirst = 0; neverEnds = false; forever.clear(); });
afterAll(async () => { vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

type Recovery = NonNullable<Parameters<typeof import("./cloud-computer-tools.ts").cloudComputerRpc>[1]["recovery"]>;
const rpc = (request: unknown, gate: { held: boolean; reason?: "person"; blockedReason?: string } = { held: false }, signal = new AbortController().signal, recovery?: Recovery, budgetMs?: number, settled?: (answered: boolean) => void) => {
  let gated = 0;
  let checks = 0;
  const done = tools.cloudComputerRpc(request as never, {
    cfg, boxId: () => "bx_23456789", signal,
    gate: async () => { gated++; return gate; },
    assertActive: () => { checks++; }, recovery, ...(budgetMs === undefined ? {} : { budgetMs }), ...(settled ? { settled } : {}),
  });
  return { done, gated: () => gated, checks: () => checks };
};

describe("cloud computer tools", () => {
  it("lists the same thirteen tools for every engine", async () => {
    const listed = await rpc({ method: "tools/list", params: {} }).done as { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }> };
    expect(listed.tools.map(tool => tool.name)).toEqual([
      "screenshot", "get_screen_size", "click", "move", "drag", "type_text", "key_press", "scroll", "open_url", "exec", "exec_status",
      "copy_from_computer", "copy_to_computer",
    ]);
    expect(calls).toEqual([]);
    const exec = listed.tools.find(tool => tool.name === "exec")!;
    expect(exec.description).toContain("Completion does not automatically resume this turn or notify a delegator");
    expect(exec.description).toContain("use exec_status with wait_seconds in this turn");
    expect(exec.description).toContain("check its exit code and output");
    expect(exec.description).toContain("report the work as unfinished with the process_id");
    const status = listed.tools.find(tool => tool.name === "exec_status")!;
    expect(status.inputSchema.properties.wait_seconds.description).toContain("A running result can arrive before the full interval");
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
    expect(calls.map(entry => entry.path)).toEqual(["/sandboxes/bx_23456789/commands"]);
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
    await expect(tools.runCloudComputerTool(cfg, "bx_23456789", name, args as never, new AbortController().signal))
      .resolves.toMatchObject({ isError: true });
    expect(calls).toHaveLength(0);
  });

  it("never opens Reddit in the cloud computer's browser, and says why, before the control gate or the Boat", async () => {
    const { REDDIT_REFUSAL } = await import("./browser/egress/reddit.ts");
    for (const url of ["https://www.reddit.com/r/test/", "http://old.reddit.com/", "https://i.redd.it/a.png", "https://reddit.app.link/x", "https://WWW.REDDIT.COM./"]) {
      const call = rpc({ method: "tools/call", params: { name: "open_url", arguments: { url } } });
      expect(await call.done, url).toEqual({ isError: true, content: [{ type: "text", text: REDDIT_REFUSAL }] });
      expect(call.gated()).toBe(0);
      await expect(tools.runCloudComputerTool(cfg, "bx_23456789", "open_url", { url }, new AbortController().signal))
        .resolves.toEqual({ isError: true, content: [{ type: "text", text: REDDIT_REFUSAL }] });
    }
    expect(calls).toHaveLength(0);
    await tools.runCloudComputerTool(cfg, "bx_23456789", "open_url", { url: "https://notreddit.com/" }, new AbortController().signal);
    expect(calls[0].body.command).toMatch(/xdg-open .*https:\/\/notreddit\.com\//);
  });

  it.each([
    ["a person holds control", { held: true, reason: "person" as const }, "A person has taken control of this computer"],
    ["another thread owns the seat", { held: true, blockedReason: "Another thread is using this computer." }, "Another thread is using this computer."],
    ["the hold has no reason", { held: true }, "could not confirm that this computer is free"],
  ])("performs nothing on the Boat when %s", async (_label, gate, text) => {
    const call = rpc({ method: "tools/call", params: { name: "click", arguments: { x: 3, y: 4 } } }, gate);
    const result = await call.done as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(text);
    expect(calls).toHaveLength(0);
  });

  it("acts on the Boat the gate started, read only once the gate let the call through", async () => {
    // A cloud computer mounted before it existed: the gate's claim creates
    // it, and only then is there a Boat to act on.
    let started: string | undefined;
    const result = await tools.cloudComputerRpc({ method: "tools/call", params: { name: "get_screen_size", arguments: {} } }, {
      cfg, boxId: () => started, signal: new AbortController().signal,
      gate: async () => { started = "bx_3456789a"; return { held: false }; }, assertActive: () => {},
    }) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(calls.map(entry => entry.path)).toEqual(["/sandboxes/bx_3456789a/commands"]);
  });

  describe("with the computer's disk watched", () => {
    type Disk = NonNullable<Parameters<typeof tools.cloudComputerRpc>[1]["disk"]>;
    const withDisk = (disk: Disk, name = "exec", args: Record<string, unknown> = { command: "printf fixture" }) =>
      tools.cloudComputerRpc({ method: "tools/call", params: { name, arguments: args } }, {
        cfg, boxId: () => "bx_23456789", signal: new AbortController().signal, gate: async () => ({ held: false }), assertActive: () => {}, disk,
      }) as Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;

    it("tells the disk when the call begins and ends, around the command, and ends the result with its note", async () => {
      const seen: string[] = [];
      const result = await withDisk({
        began: (_cfg, boxId) => { seen.push(`began ${boxId} after ${calls.length} calls`); },
        ended: (_cfg, boxId) => { seen.push(`ended ${boxId} after ${calls.length} calls`); },
        after: async (_cfg, boxId, texts, failed) => { seen.push(`after ${boxId} failed=${failed}: ${texts.join("|")}`); return "Disk note: this cloud computer's disk is 91% full."; },
      });
      expect(seen).toEqual([
        "began bx_23456789 after 0 calls", `after bx_23456789 failed=false: ${JSON.stringify({ ok: true, exitCode: 0, stdout: "captured", stderr: "" })}`, "ended bx_23456789 after 1 calls",
      ]);
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify({ ok: true, exitCode: 0, stdout: "captured", stderr: "" }) },
        { type: "text", text: "Disk note: this cloud computer's disk is 91% full." },
      ]);
    });

    it("leaves the result as it is when there is nothing to say, and a failed command stays failed with the note after it", async () => {
      expect((await withDisk({ began: () => {}, ended: () => {}, after: async () => null })).content).toHaveLength(1);
      commandExit = 1;
      const flags: boolean[] = [];
      const failed = await withDisk({ began: () => {}, ended: () => {}, after: async (_cfg, _boxId, _texts, flag) => { flags.push(flag); return "Disk note: this cloud computer's disk is 99% full. Writes may fail until space is freed."; } });
      expect(flags).toEqual([true]);
      expect(failed.isError).toBe(true);
      expect(failed.content.map((part) => part.text)).toEqual([JSON.stringify({ ok: false, exitCode: 1, stdout: "captured", stderr: "" }), "Disk note: this cloud computer's disk is 99% full. Writes may fail until space is freed."]);
    });

    it("asks for no note after a call the computer did not answer, and still counts the call as ended", async () => {
      commandStatus = 502;
      let asked = 0;
      let open = 0;
      const result = await tools.cloudComputerRpc({ method: "tools/call", params: { name: "click", arguments: { x: 1, y: 2 } } }, {
        cfg, boxId: () => "bx_23456789", signal: new AbortController().signal, gate: async () => ({ held: false }), assertActive: () => {}, budgetMs: 6_000,
        disk: { began: () => { open++; }, ended: () => { open--; }, after: async () => { asked++; return "never shown"; } },
      }) as { content: unknown[] };
      expect(asked).toBe(0);
      expect(open).toBe(0);
      expect(result.content).toHaveLength(1);
    });

    it("counts a call that was stopped before it was sent as ended", async () => {
      const stop = new AbortController();
      stop.abort();
      let open = 0;
      await expect(tools.cloudComputerRpc({ method: "tools/call", params: { name: "click", arguments: { x: 1, y: 2 } } }, {
        cfg, boxId: () => "bx_23456789", signal: stop.signal, gate: async () => ({ held: false }), assertActive: () => {},
        disk: { began: () => { open++; }, ended: () => { open--; }, after: async () => null },
      })).rejects.toThrow();
      expect(open).toBe(0);
    });
  });

  it("performs nothing when the gate let a call through and no Boat landed", async () => {
    const result = await tools.cloudComputerRpc({ method: "tools/call", params: { name: "exec", arguments: { command: "true" } } }, {
      cfg, boxId: () => null, signal: new AbortController().signal, gate: async () => ({ held: false }), assertActive: () => {},
    }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: tools.CLOUD_COMPUTER_NOT_READY }] });
    expect(calls).toHaveLength(0);
  });

  it("stops when the turn's capability is gone, before and after the Boat acts", async () => {
    const expired = () => { throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 }); };
    await expect(tools.cloudComputerRpc({ method: "tools/list" }, {
      cfg, boxId: () => "bx_23456789", signal: new AbortController().signal, gate: async () => ({ held: false }), assertActive: expired,
    })).rejects.toThrow("expired");
    await expect(tools.cloudComputerRpc({ method: "tools/call", params: { name: "exec", arguments: { command: "true" } } }, {
      cfg, boxId: () => "bx_23456789", signal: new AbortController().signal, gate: async () => ({ held: false }), assertActive: expired,
    })).rejects.toThrow("expired");
    expect(calls).toHaveLength(0);
    await expect(rpc({ method: "resources/read" }).done).rejects.toMatchObject({ status: 400 });
  });

  it("answers a call the gate refused with the refusal, even when the turn ended while it waited", async () => {
    const ended = () => { throw Object.assign(new Error("This bot turn has already ended"), { status: 401 }); };
    const blockedReason = "The cloud computer could not be started: the cloud computer didn't start in time. This call was not performed.";
    const result = await tools.cloudComputerRpc({ method: "tools/call", params: { name: "screenshot", arguments: {} } }, {
      cfg, boxId: () => null, signal: new AbortController().signal, gate: async () => ({ held: true, blockedReason }), assertActive: ended,
    });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: expect.stringContaining(blockedReason) }] });
    expect(calls).toHaveLength(0);
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
    expect(calls.filter(entry => entry.path.endsWith("/commands") && String(entry.body.command).includes("printf fixture"))).toHaveLength(1);
    // The person stopped the turn, so the command it was waiting on is stopped too, by the call's own key.
    await vi.waitFor(() => expect(calls.some(entry => entry.path.endsWith("/commands") && String(entry.body.command).includes("kill -TERM"))).toBe(true));
    server.closeAllConnections();
  });

  it("answers within its call budget, the gate's wait included, when the Boat holds a command", async () => {
    holdCommand = true;
    const BUDGET_MS = 3_000;
    const started = Date.now();
    const result = await tools.cloudComputerRpc({ method: "tools/call", params: { name: "exec", arguments: { command: "sleep 600" } } }, {
      // Room for a slow runner to get the request out after the gate's wait. The answer may come before the budget ends
      // (the command's own limit ends first), never after it by more than a slow machine's slack.
      cfg, boxId: () => "bx_23456789", signal: new AbortController().signal, budgetMs: BUDGET_MS, assertActive: () => {},
      gate: async () => { await new Promise(resolve => setTimeout(resolve, 300)); return { held: false }; },
    });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: (await import("./cloud-computer-background.ts")).EXEC_LATE }] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS + 10_000);
    expect(calls.filter(entry => entry.path.endsWith("/commands") && String(entry.body.command).includes("sleep 600"))).toHaveLength(1);
    expect(calls.some(entry => String(entry.body?.command).includes("kill -TERM"))).toBe(false);
    server.closeAllConnections();
  });

  it("hands a command that outlasts its call back still running, with a process id exec_status follows, instead of an error", async () => {
    neverEnds = true;
    const result = await tools.cloudComputerRpc({ method: "tools/call", params: { name: "exec", arguments: { command: "make forever" } } }, {
      cfg, boxId: () => "bx_23456789", signal: new AbortController().signal, budgetMs: 32_000, assertActive: () => {}, gate: async () => ({ held: false }),
    }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBeFalsy();
    const handed = JSON.parse(result.content[0]!.text!);
    expect(handed).toMatchObject({ status: "running", stdout: "compiling", next: tools.EXEC_STILL_RUNNING });
    expect(calls.filter(entry => entry.path.endsWith("/commands") && entry.body?.detached === true)).toHaveLength(1);
    const status = await tools.cloudComputerRpc({ method: "tools/call", params: { name: "exec_status", arguments: { process_id: handed.processId } } }, {
      cfg, boxId: () => "bx_23456789", signal: new AbortController().signal, assertActive: () => {}, gate: async () => ({ held: false }),
    }) as { content: Array<{ text?: string }> };
    expect(JSON.parse(status.content[0]!.text!)).toMatchObject({ status: "running", processId: handed.processId });
  }, 60_000);

  it("sends pointer calls, key calls and screenshots the direct way, in one round trip, and exec the way that survives a long run", async () => {
    await rpc({ method: "tools/call", params: { name: "click", arguments: { x: 1, y: 2 } } }).done;
    await rpc({ method: "tools/call", params: { name: "screenshot", arguments: {} } }).done;
    await rpc({ method: "tools/call", params: { name: "exec", arguments: { command: "pwd" } } }).done;
    expect(calls.filter(entry => entry.path.endsWith("/commands")).map(entry => entry.body.detached === true)).toEqual([false, false, true]);
  });

  it("answers that the command ran out of time, as a result, when its start gets no reply", async () => {
    holdCommand = true;
    const result = await tools.cloudComputerRpc({ method: "tools/call", params: { name: "exec", arguments: { command: "make" } } }, {
      cfg, boxId: () => "bx_23456789", signal: new AbortController().signal, budgetMs: 8_000, assertActive: () => {}, gate: async () => ({ held: false }),
    });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: (await import("./cloud-computer-background.ts")).EXEC_LATE }] });
    expect(calls.filter(entry => entry.path.endsWith("/commands") && String(entry.body.command).includes("make"))).toHaveLength(1);
    server.closeAllConnections();
  }, 20_000);

  describe("with five long-running commands already left on the computer by earlier exec calls", () => {
    const exec = (command: string, budgetMs?: number) => tools.cloudComputerRpc({ method: "tools/call", params: { name: "exec", arguments: { command } } }, {
      cfg, boxId: () => "bx_23456789", signal: new AbortController().signal, assertActive: () => {}, gate: async () => ({ held: false }), ...(budgetMs ? { budgetMs } : {}),
    }) as Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
    const fiveDevServers = async () => {
      neverEnds = true;
      const { noteLeftRunning } = await import("./boat-command.ts");
      for (const id of [1, 2, 3, 4, 5]) { forever.add(id); noteLeftRunning("bx_23456789", id); }
    };

    it("still runs the command that stops them, and any other short command", async () => {
      await fiveDevServers();
      const stopped = await exec("pkill -f devserver");
      expect(stopped.isError).toBeFalsy();
      expect(JSON.parse(stopped.content[0]!.text!)).toMatchObject({ ok: true, exitCode: 0 });
      expect((await exec("ls")).isError).toBeFalsy();
      const click = await rpc({ method: "tools/call", params: { name: "click", arguments: { x: 1, y: 2 } } }).done as { isError?: boolean };
      expect(click.isError).toBeFalsy();
    });

    it("stops a sixth one when its call's time runs out, instead of leaving it, and says how to see and stop the others", async () => {
      await fiveDevServers();
      const sixth = await exec("devserver forever", 32_000);
      expect(sixth).toEqual({ isError: true, content: [{ type: "text", text: tools.TOO_MANY_LEFT_RUNNING }] });
      expect(tools.TOO_MANY_LEFT_RUNNING).toMatch(/background: true.*ps -eo.*kill <pid>/s);
      const sent = calls.filter(entry => entry.path.endsWith("/commands")).map(entry => String(entry.body.command));
      const key = /^k=([0-9a-f]{16});/.exec(sent.find(command => command.includes("devserver forever"))!)![1]!;
      expect(sent.some(command => command.startsWith(`k=${key}; p=;`) && command.includes("kill -TERM"))).toBe(true);
      // With one of the five gone, the next long command is handed back as usual.
      forever.delete(5);
      const next = await exec("watcher forever", 32_000);
      expect(next.isError).toBeFalsy();
      expect(JSON.parse(next.content[0]!.text!)).toMatchObject({ status: "running" });
    }, 120_000);
  });

  describe("a computer that stopped answering", () => {
    const words = () => import("../shared/cloud-computer-recovery.ts");
    /** A call with little time left, so a computer that never answers is given up on at once. */
    const SHORT = 6_000;
    const call = (name: string, args: Record<string, unknown>, recovery?: Recovery, budgetMs: number | undefined = SHORT, settled?: (answered: boolean) => void) =>
      rpc({ method: "tools/call", params: { name, arguments: args } }, { held: false }, new AbortController().signal, recovery, budgetMs, settled).done as Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;

    it("says a call got no answer, instead of an empty failed result", async () => {
      commandStatus = 502;
      const outcomes: boolean[] = [];
      const result = await call("click", { x: 1, y: 2 }, undefined, SHORT, (answered) => outcomes.push(answered));
      expect(result).toEqual({ isError: true, content: [{ type: "text", text: (await words()).CLOUD_COMPUTER_STILL_WAKING }] });
      expect(outcomes).toEqual([false]);
    });

    it("rides out a short burst of gateway errors inside the call: the bot gets the result, and the command ran once", async () => {
      unansweredFirst = 2;
      const outcomes: boolean[] = [];
      const result = await call("exec", { command: "printf fixture" }, undefined, 60_000, (answered) => outcomes.push(answered));
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ ok: true, exitCode: 0, stdout: "captured" });
      const sent = calls.filter(entry => entry.path.endsWith("/commands")).map(entry => String(entry.body.command));
      const copies = sent.filter(command => command.includes("printf fixture"));
      const key = /^k=([0-9a-f]{16});/.exec(copies[0]!)?.[1];
      expect(key).toBeDefined();
      // Every copy of the call carries the same claim, so the computer runs at most one of them.
      expect(copies.length).toBeGreaterThanOrEqual(2);
      expect(copies.every(command => command.startsWith(`k=${key};`))).toBe(true);
      const { DISK_CHECK_COMMAND } = await import("./cloud-computer-disk.ts");
      expect(sent.filter(command => command === "true" || command === DISK_CHECK_COMMAND).length).toBeGreaterThanOrEqual(1);
      expect(outcomes).toEqual([true]);
    });

    it("takes a screenshot again once the computer answers, since a screenshot changes nothing", async () => {
      unansweredFirst = 1;
      const result = await call("screenshot", {}, undefined, 60_000);
      expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    });

    it("refuses calls without touching the computer while it is being restarted or replaced", async () => {
      const { CLOUD_COMPUTER_NOT_RESPONDING } = await words();
      const result = await call("click", { x: 1, y: 2 }, { refusal: (_box, phase) => phase === "before" ? CLOUD_COMPUTER_NOT_RESPONDING : null, notice: () => null });
      expect(result).toEqual({ isError: true, content: [{ type: "text", text: CLOUD_COMPUTER_NOT_RESPONDING }] });
      expect(calls).toEqual([]);
    });

    it("tells what is known about a computer that did not answer, and leaves a command's own failure as it is", async () => {
      const { CLOUD_COMPUTER_UNREACHABLE } = await words();
      const recovery: Recovery = { refusal: (_box, phase) => phase === "after" ? CLOUD_COMPUTER_UNREACHABLE : null, notice: () => null };
      commandStatus = 502;
      expect((await call("click", { x: 1, y: 2 }, recovery)).content).toEqual([{ type: "text", text: CLOUD_COMPUTER_UNREACHABLE }]);
      commandStatus = 200;
      commandExit = 1;
      const failed = await call("exec", { command: "false" }, recovery);
      expect(failed.isError).toBe(true);
      expect(JSON.parse(failed.content[0]!.text!)).toMatchObject({ ok: false, exitCode: 1 });
    });

    it("puts the replacement notice once before the first result on the new computer", async () => {
      const { CLOUD_COMPUTER_REPLACED } = await words();
      let owed = true;
      const recovery: Recovery = { refusal: () => null, notice: () => (owed ? ((owed = false), CLOUD_COMPUTER_REPLACED) : null) };
      const first = await call("get_screen_size", {}, recovery);
      expect(first.content[0]).toEqual({ type: "text", text: CLOUD_COMPUTER_REPLACED });
      expect(first.content).toHaveLength(2);
      const second = await call("get_screen_size", {}, recovery);
      expect(second.content).toHaveLength(1);
    });
  });
});
