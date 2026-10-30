import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROL_UNCONFIRMED } from "./control-client.ts";
import { gatedLocalComputer } from "./local-computer.ts";
import { OWN_PROFILE_UNAVAILABLE } from "./local-computer-guidance.ts";
import { ComputerJournal, parseJournalEntry } from "./saved-steps/journal.ts";
import { CLICK_SENT_UNCONFIRMED } from "./unconfirmed-click.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { wideSchema } from "./testing/oversized-tool-schema.ts";
import { TOOL_SCHEMA_PROFILE_ENV } from "./tool-schema-profile.ts";

// A disposable MCP child that never opens a computer or reads user data.
const FAKE_DRIVER = `
const readline = require("node:readline");
let calls = 0;
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "tools/call") calls += 1;
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{
    forwarded:message.method,calls,
    marker:process.env.CUA_FIXTURE_MARKER,
    tokenPresent:Boolean(process.env.OMB_CONTROL_TOKEN),
    path:process.env.PATH,
    argv:process.argv.slice(1),
    tail:message.params?.large ? "x".repeat(150000) : ""
  }}) + "\\n");
});
`;

// Notepad behind cua-driver 0.28.2 on Windows: of one SendInput burst only the first character lands, the rest repeat the last.
const PACING_DRIVER = `
const readline = require("node:readline");
const hex = (value) => "0x" + value.toString(16);
const owners = { [0x30a5c]: 4242, [0x1f00]: 77 };
let front = 0x1f00, document = "";
const calls = [];
const answer = (name, args) => {
  calls.push(name);
  if (name === "bring_to_front") {
    const target = args.window_id, previous = front;
    front = target;
    return { content: [{ type: "text", text: "front" }], structuredContent: { previous_fg_hwnd: hex(previous), now_fg_hwnd: hex(target), target_hwnd: hex(target), landed_on_target: true } };
  }
  if (name === "list_windows") return { content: [{ type: "text", text: "windows" }], structuredContent: { windows: Object.entries(owners).map(([id, pid]) => ({ window_id: Number(id), pid })) } };
  if (name === "type_text") {
    const text = args.text;
    document += text.length < 2 ? text : text[0] + text.at(-1).repeat(text.length - 1);
    return { content: [{ type: "text", text: "typed" }], structuredContent: { effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } } };
  }
  if (name === "click") return { content: [{ type: "text", text: "foreground_unavailable: exact target HWND 0x30a5c or a verified same-process post-action window was not foreground after the click (actual foreground HWND 0x1f00)" }], isError: true, structuredContent: { code: "tool_invocation_failed" } };
  return { content: [{ type: "text", text: JSON.stringify({ document, calls, front }) }] };
};
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cua-driver", version: "0.28.2" } }
    : answer(message.params.name, message.params.arguments);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

describe("local computer proxy (isolated child and control endpoint)", () => {
  it.each(["node", "electron"])("%s: keeps discovery lease-free, refuses contention and outages, and drains the final gated frame", async (runtime) => {
    let held = true;
    let unavailable = false;
    let delayMs = 0;
    let reads = 0;
    const auth: Array<string | undefined> = [];
    const reason = "Another thread is using this computer. This call was not performed.";
    const server = createServer((request, response) => {
      reads += 1;
      auth.push(request.headers.authorization);
      setTimeout(() => {
        response.writeHead(unavailable ? 503 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify({ held, helpOpen: false, ...(held ? { blockedReason: reason } : {}) }));
      }, delayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const original = {
      command: process.execPath,
      args: ["-e", FAKE_DRIVER, "--", "two words; not a shell"],
      env: { CUA_FIXTURE_MARKER: "preserved-driver-env" },
      platform: "darwin" as const, scope: "local-computer" as const,
    };
    const control = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/control`, token: "isolated-control-token" };
    let connection = gatedLocalComputer(original, control);
    const home = mkdtempSync(join(tmpdir(), "omb-cua-launch-"));
    let child: ChildProcess | undefined;
    try {
      if (runtime === "electron") {
        // Built inside Electron: in a Node-only process execPath hides a missing ELECTRON_RUN_AS_NODE. Never loads the user's app,
        // daemon or data, and fails before spawning a malformed descriptor (which would launch a GUI).
        const electron = createRequire(import.meta.url)("electron") as string;
        const moduleUrl = new URL("./local-computer.ts", import.meta.url).href;
        const bootstrap = spawnSync(electron, ["--input-type=module", "-e", `
          const { gatedLocalComputer } = await import(${JSON.stringify(moduleUrl)});
          const { original, control } = JSON.parse(process.env.OMB_FIXTURE_CONNECTION);
          process.stdout.write(JSON.stringify(gatedLocalComputer(original, control)));
        `], {
          env: { ...process.env, HOME: home, USERPROFILE: home, ELECTRON_RUN_AS_NODE: "1", OMB_FIXTURE_CONNECTION: JSON.stringify({ original, control }) },
          encoding: "utf8", timeout: 10_000,
        });
        expect(bootstrap.status, bootstrap.stderr).toBe(0);
        connection = JSON.parse(bootstrap.stdout);
        expect(pathToFileURL(connection.command).href).toBe(pathToFileURL(electron).href);
      }
      expect(connection.env.ELECTRON_RUN_AS_NODE).toBe("1");
      child = spawn(connection.command, connection.args, { env: { ...process.env, ...connection.env,
        HOME: home, USERPROFILE: home, OMB_EXTRA_PATH: dirname(process.execPath), PATH: "",
      }, stdio: ["pipe", "pipe", "pipe"] });
      const input = createInterface({ input: child.stdout! });
      const replies = new Map<number, (value: any) => void>();
      let stderr = "";
      child.stderr!.on("data", (chunk) => { stderr += chunk; });
      input.on("line", (line) => {
        const message = JSON.parse(line);
        replies.get(message.id)?.(message);
        replies.delete(message.id);
      });
      let nextId = 0;
      const rpc = (method: string, params = {}, end = false, waitMs = 5_000): Promise<any> => {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no fixture response for ${id}`)), waitMs);
          replies.set(id, (value) => { clearTimeout(timer); resolve(value); });
          const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
          if (end) child!.stdin!.end(frame);
          else child!.stdin!.write(frame);
        });
      };
      expect((await rpc("initialize")).result.forwarded).toBe("initialize");
      expect((await rpc("tools/list")).result.forwarded).toBe("tools/list");
      expect(reads).toBe(0);
      expect((await rpc("ping")).result).toEqual({});
      const refused = await rpc("tools/call", { name: "click" });
      expect(refused.result).toMatchObject({ isError: true, content: [{ type: "text", text: reason }] });
      // The harness holds its check while the computer is busy; the bridge's real client must wait past 2 s.
      delayMs = 2_600;
      const slow = await rpc("tools/call", { name: "click" }, false, 8_000);
      expect(slow.result).toMatchObject({ isError: true, content: [{ type: "text", text: reason }] });
      delayMs = 0;
      held = false;
      const allowed = await rpc("tools/call", { name: "screenshot" });
      expect(allowed.result).toMatchObject({ calls: 1, marker: "preserved-driver-env", tokenPresent: false, argv: ["two words; not a shell"] });
      expect(allowed.result.path.split(delimiter)).toContain(dirname(process.execPath));
      unavailable = true;
      const outage = await rpc("tools/call", { name: "click" });
      expect(outage.result).toMatchObject({ isError: true, content: [{ type: "text", text: CONTROL_UNCONFIRMED }] });
      unavailable = false;
      const exited = once(child, "exit");
      const final = await rpc("tools/call", { name: "screenshot", large: true }, true);
      expect(final.result.calls).toBe(2);
      expect(final.result.tail).toHaveLength(150_000);
      expect(await exited).toEqual([0, null]);
      expect(auth.every((header) => header === "Bearer isolated-control-token")).toBe(true);
      expect(stderr).not.toContain("isolated-control-token");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("journals each tools/call before the engine sees its reply, and forwards anyway when the journal is slow", async () => {
    const driver = `
const readline = require("node:readline");
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{content:[{type:"text",text:"private"}],structuredContent:{pid:7,elements:[{element_index:1,role:"AXButton",label:"Go",depth:1,value:"private"}]}}}) + "\\n");
});
`;
    let journalDelayMs = 300;
    let journalNever = false;
    const posts: Array<{ at: number; auth: string | undefined; path: string | undefined; body: any }> = [];
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        let raw = "";
        request.on("data", (chunk) => { raw += chunk; });
        request.on("end", () => {
          posts.push({ at: Date.now(), auth: request.headers.authorization, path: request.url, body: JSON.parse(raw) });
          if (journalNever) return;
          setTimeout(() => { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); }, journalDelayMs);
        });
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ held: false, helpOpen: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const connection = gatedLocalComputer(
      { command: process.execPath, args: ["-e", driver], env: {}, platform: "darwin", scope: "local-computer" },
      { url: `http://127.0.0.1:${port}/control?botId=b1`, token: "journal-fixture-token" },
    );
    const run = async (env: Record<string, string>, body: (rpc: (id: number) => Promise<{ at: number; message: any }>) => Promise<void>) => {
      const child = spawn(connection.command, connection.args, { env: { ...process.env, ...connection.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      try {
        const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
        await body(async (id) => {
          child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "anything", arguments: { query: "x" } } }) + "\n");
          const { value } = await lines.next();
          return { at: Date.now(), message: JSON.parse(value as string) };
        });
      } finally {
        child.kill("SIGKILL");
      }
    };
    try {
      await run({ OMB_COMPUTER_JOURNAL: "1" }, async (rpc) => {
        const first = await rpc(1);
        expect(posts).toHaveLength(1);
        expect(first.at).toBeGreaterThanOrEqual(posts[0].at + 250);
        expect(posts[0].path).toBe("/api/internal/computer/journal");
        expect(posts[0].auth).toBe("Bearer journal-fixture-token");
        expect(posts[0].body).toEqual({
          tool: "anything", arguments: { query: "x" },
          result: { isError: false, structured: { pid: 7, elements: [{ element_index: 1, role: "AXButton", label: "Go", depth: 1, value_read: true }] } },
        });
        expect(first.message.result.structuredContent.pid).toBe(7);

        journalNever = true;
        const startedAt = Date.now();
        const second = await rpc(2);
        expect(posts).toHaveLength(2);
        expect(second.at - startedAt).toBeLessThan(1_500);
        expect(second.message.id).toBe(2);
      });
      posts.length = 0;
      await run({ OMB_COMPUTER_JOURNAL: "" }, async (rpc) => {
        await rpc(3);
        expect(posts).toHaveLength(0);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("hands every engine a provider-safe tools/list, whatever root schema the driver ships", async () => {
    // cua-driver 0.22.1's browser_prepare root: an anyOf of untyped branches that strict providers refuse.
    const driver = `
const readline = require("node:readline");
const inputSchema = {type:"object",required:[],additionalProperties:true,
  properties:{pid:{type:"integer"},allow_launch:{type:"boolean"},profile:{type:"object",properties:{mode:{type:"string"}}}},
  anyOf:[{required:["pid"]},{required:["allow_launch","profile"],properties:{allow_launch:{const:true}}}]};
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const message = JSON.parse(line);
  const result = message.method === "tools/list"
    ? {tools:[{name:"browser_prepare",inputSchema},{name:"click",inputSchema:{type:"object",properties:{}}}]}
    : {echo:{inputSchema}};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result}) + "\\n");
});
`;
    const connection = gatedLocalComputer(
      { command: process.execPath, args: ["-e", driver], env: {}, platform: "win32", scope: "local-computer" },
      { url: "http://127.0.0.1:1/control", token: "schema-fixture-token" },
    );
    const child = spawn(connection.command, connection.args, { env: { ...process.env, ...connection.env }, stdio: ["pipe", "pipe", "pipe"] });
    try {
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
      const rpc = async (id: number | string, method: string) => {
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method }) + "\n");
        const { value } = await lines.next();
        return JSON.parse(value as string);
      };

      const listed = await rpc("list-1", "tools/list");
      const [prepare, click] = listed.result.tools;
      expect(prepare.inputSchema).toEqual({
        type: "object",
        additionalProperties: true,
        properties: { pid: { type: "integer" }, allow_launch: { type: "boolean" }, profile: { type: "object", properties: { mode: { type: "string" } } } },
      });
      expect(click.inputSchema).toEqual({ type: "object", properties: {} });

      const other = await rpc(2, "initialize");
      expect(other.result.echo.inputSchema.anyOf).toHaveLength(2);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("fits the driver's tools to the engine's provider profile when the turn carries one", async () => {
    const wide = wideSchema(110);
    const driver = `
const readline = require("node:readline");
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{tools:[{name:"configure",inputSchema:${JSON.stringify(wide)}}]}}) + "\\n");
});
`;
    const connection = gatedLocalComputer(
      { command: process.execPath, args: ["-e", driver], env: {}, platform: "darwin", scope: "local-computer" },
      { url: "http://127.0.0.1:1/control", token: "schema-fixture-token" },
    );
    const listed = async (env: Record<string, string>) => {
      const child = spawn(connection.command, connection.args, { env: { ...process.env, ...connection.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      try {
        const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
        return JSON.parse((await lines.next()).value as string).result.tools[0].inputSchema;
      } finally {
        child.kill("SIGKILL");
      }
    };
    expect(JSON.stringify(await listed({ [TOOL_SCHEMA_PROFILE_ENV]: "moonshot" })).length).toBeLessThanOrEqual(12_000);
    expect(await listed({})).toEqual(wide);
  });

  it("adds what to do instead to the driver's refusal to attach to the person's signed-in profile", async () => {
    const refusal = {
      content: [{ type: "text", text: "refused (browser_consent_required): existing-profile attachment in standard mode requires --grant existing-profile or an embedding authorization host; bounded mode requires a matching manifest" }],
      structuredContent: { refusal: { code: "browser_consent_required", message: "existing-profile attachment in standard mode requires --grant existing-profile or an embedding authorization host; bounded mode requires a matching manifest" }, status: "refused" },
    };
    const driver = `
const readline = require("node:readline");
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:${JSON.stringify(refusal)}}) + "\\n");
});
`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ held: false, helpOpen: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const connection = gatedLocalComputer(
      { command: process.execPath, args: ["-e", driver], env: {}, platform: "darwin", scope: "local-computer" },
      { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/control`, token: "guidance-fixture-token" },
    );
    const child = spawn(connection.command, connection.args, { env: { ...process.env, ...connection.env }, stdio: ["pipe", "pipe", "pipe"] });
    try {
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_prepare", arguments: { pid: 1, window_id: 1, strategy: { kind: "existing_profile" } } } }) + "\n");
      const answer = JSON.parse((await lines.next()).value as string);
      expect(answer.result.content).toEqual([...refusal.content, { type: "text", text: OWN_PROFILE_UNAVAILABLE }]);
      expect(answer.result.structuredContent).toEqual(refusal.structuredContent);
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["win32", "darwin"] as const)("%s: a foreground type_text reaches the driver so that every character lands", async (platform) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ held: false, helpOpen: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const connection = gatedLocalComputer(
      { command: process.execPath, args: ["-e", PACING_DRIVER], env: {}, platform, scope: "local-computer" },
      { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/control`, token: "typing-fixture-token" },
    );
    const child = spawn(connection.command, connection.args, { env: { ...process.env, ...connection.env }, stdio: ["pipe", "pipe", "pipe"] });
    try {
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
      const rpc = async (id: number, method: string, params: Record<string, unknown> = {}) => {
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        const answer = JSON.parse((await lines.next()).value as string);
        expect(answer.id).toBe(id);
        return answer.result;
      };
      const state = async (id: number) => JSON.parse((await rpc(id, "tools/call", { name: "read_fixture", arguments: {} })).content[0].text);
      await rpc(1, "initialize");
      const text = " Zeile Drei";
      const typed = await rpc(2, "tools/call", { name: "type_text", arguments: { pid: 4242, window_id: 0x30a5c, delivery_mode: "foreground", text } });
      const after = await state(3);
      const clicked = await rpc(4, "tools/call", { name: "click", arguments: { pid: 4242, window_id: 0x30a5c, x: 10, y: 20, delivery_mode: "foreground" } });
      if (platform === "win32") {
        expect(after.document).toBe(text);
        expect(typed.content[0].text).toBe("✅ Typed 11 char(s) on pid 4242 via SendInput (delivery_mode:foreground), one character at a time.");
        expect(after.calls).toEqual([...[...text].flatMap(() => ["bring_to_front", "type_text"]), "list_windows", "bring_to_front", "read_fixture"]);
        expect(after.front).toBe(0x1f00);
        expect(clicked).toEqual({ content: [{ type: "text", text: CLICK_SENT_UNCONFIRMED }], structuredContent: { effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } } });
      } else {
        expect(after.document).toBe(" iiiiiiiiii");
        expect(after.calls).toEqual(["type_text", "read_fixture"]);
        expect(clicked.isError).toBe(true);
      }
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["win32", "darwin"] as const)("%s: a call the bridge answers itself is never journalled, so its request stays incomplete", async (platform) => {
    const journal = new ComputerJournal();
    let generation = "plain";
    const scope = () => ({ botId: "b1", threadId: "t1", generation });
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        if (request.method === "POST") {
          const entry = parseJournalEntry(JSON.parse(raw));
          if (entry) journal.record(scope(), entry);
        } else journal.gateChecked(scope());
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(request.method === "POST" ? { ok: true } : { held: false, helpOpen: false }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const connection = gatedLocalComputer(
      { command: process.execPath, args: ["-e", PACING_DRIVER], env: {}, platform, scope: "local-computer" },
      { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/control`, token: "relay-journal-fixture-token" },
      true,
    );
    const child = spawn(connection.command, connection.args, { env: { ...process.env, ...connection.env }, stdio: ["pipe", "pipe", "pipe"] });
    try {
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
      const rpc = async (id: number, method: string, params: Record<string, unknown> = {}) => {
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        expect(JSON.parse((await lines.next()).value as string).id).toBe(id);
      };
      const taken = (request: string) => {
        const { calls, complete } = journal.take("t1", new Set([request]))!;
        return { tools: calls.map((call) => call.tool), complete };
      };
      await rpc(1, "initialize");
      await rpc(2, "tools/call", { name: "read_fixture", arguments: {} });
      expect(taken("plain")).toEqual({ tools: ["read_fixture"], complete: true });

      generation = "relayed";
      await rpc(3, "tools/call", { name: "type_text", arguments: { pid: 4242, window_id: 0x30a5c, delivery_mode: "foreground", text: "ab" } });
      await rpc(4, "tools/call", { name: "click", arguments: { pid: 4242, window_id: 0x30a5c, x: 10, y: 20, delivery_mode: "foreground" } });
      await rpc(5, "tools/call", { name: "read_fixture", arguments: {} });
      expect(taken("relayed")).toEqual(platform === "win32"
        ? { tools: ["read_fixture"], complete: false }
        : { tools: ["type_text", "click", "read_fixture"], complete: true });
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects malformed environment and missing authority without printing connection secrets", () => {
    for (const overrides of [
      { OMB_CUA_ARGS: "not-json-private-value" },
      { OMB_CUA_ARGS: '["mcp",7]' },
      { OMB_CONTROL_TOKEN: "" },
      { OMB_CONTROL_URL: "https://outside.example/control" },
    ]) {
      const result = spawnSync(process.execPath, ["--experimental-strip-types", SPAWNED_PROXIES.localComputer], {
        env: { ...process.env, OMB_CUA_COMMAND: process.execPath, OMB_CUA_ARGS: "[]", OMB_CONTROL_URL: "http://127.0.0.1:1/control", OMB_CONTROL_TOKEN: "private-fixture-token", ...overrides },
        encoding: "utf8", timeout: 5_000,
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("invalid local computer proxy connection");
      expect(result.stderr).not.toContain("private-fixture-token");
      expect(result.stderr).not.toContain("not-json-private-value");
    }
  });
});
