import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { delimiter, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { gatedLocalComputer } from "./local-computer.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

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

describe("local computer proxy (isolated child and control endpoint)", () => {
  it("keeps discovery lease-free, refuses contention and outages, and drains the final gated frame", async () => {
    let held = true;
    let unavailable = false;
    let reads = 0;
    const auth: Array<string | undefined> = [];
    const reason = "Another thread is using this computer. Pause this thread until it finishes.";
    const server = createServer((request, response) => {
      reads += 1;
      auth.push(request.headers.authorization);
      response.writeHead(unavailable ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify({ held, helpOpen: false, ...(held ? { blockedReason: reason } : {}) }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const connection = gatedLocalComputer({
      command: process.execPath,
      args: ["-e", FAKE_DRIVER, "--", "two words; not a shell"],
      env: { CUA_FIXTURE_MARKER: "preserved-driver-env" },
      platform: "darwin", scope: "local-computer",
    }, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/control`, token: "isolated-control-token" });
    let child: ChildProcess | undefined;
    try {
      child = spawn(connection.command, connection.args, { env: { ...process.env, ...connection.env,
        OMB_EXTRA_PATH: dirname(process.execPath), PATH: "",
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
      const rpc = (method: string, params = {}, end = false): Promise<any> => {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no fixture response for ${id}`)), 5_000);
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
      held = false;
      const allowed = await rpc("tools/call", { name: "screenshot" });
      expect(allowed.result).toMatchObject({ calls: 1, marker: "preserved-driver-env", tokenPresent: false, argv: ["two words; not a shell"] });
      expect(allowed.result.path.split(delimiter)).toContain(dirname(process.execPath));
      unavailable = true;
      expect((await rpc("tools/call", { name: "click" })).result.isError).toBe(true);
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
