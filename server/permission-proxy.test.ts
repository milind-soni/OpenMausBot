import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { brokerSocketPath } from "./procs.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "permission-proxy.ts");

describe("permission proxy broker continuity", () => {
  let proxy: ChildProcess | undefined;
  let broker: Server | undefined;
  let scratch = "";

  afterEach(async () => {
    proxy?.kill();
    proxy = undefined;
    await new Promise<void>((resolve) => broker?.close(() => resolve()) ?? resolve());
    broker = undefined;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = "";
  });

  it("reconnects and replays an approval after the broker restarts mid-request", async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-permission-proxy-"));
    const socketPath = brokerSocketPath(scratch, "continuity");
    const seen: Array<{ id: string; input: unknown }> = [];
    let connections: Socket[] = [];
    let firstBroker = true;

    const startBroker = async () => {
      broker = createServer((socket) => {
        connections.push(socket);
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk;
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const msg = JSON.parse(line) as { t?: string; id?: string; input?: unknown };
            if (msg.t !== "ask" || typeof msg.id !== "string") continue;
            seen.push({ id: msg.id, input: msg.input });
            if (firstBroker) {
              firstBroker = false;
              for (const connection of connections) connection.destroy();
              void new Promise<void>((resolve) => broker?.close(() => resolve())).then(startBroker);
            } else {
              socket.write(JSON.stringify({ t: "answer", id: msg.id, behavior: "allow", always: true }) + "\n");
            }
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        broker!.once("error", reject);
        broker!.listen(socketPath, resolve);
      });
    };

    // Start with no broker at all: this covers the app/server startup race.
    proxy = spawn(process.execPath, ["--experimental-strip-types", PROXY, socketPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = new Map<number, any>();
    let output = "";
    proxy.stdout!.on("data", (chunk) => {
      output += chunk;
      let nl;
      while ((nl = output.indexOf("\n")) !== -1) {
        const line = output.slice(0, nl);
        output = output.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (typeof msg.id === "number") responses.set(msg.id, msg);
      }
    });
    const waitFor = async (id: number) => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
const result = responses.get(id);
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("proxy response timed out: " + id);
    };

    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await expect(waitFor(1)).resolves.toMatchObject({ result: { serverInfo: { name: "openmausbot-permissions" } } });

    proxy.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "echo safe" }, suggestions: ["Bash(echo safe)"] } },
      }) + "\n",
    );
    await startBroker();

    const response = await waitFor(2);
    expect(response.result.content[0].text).toContain('"behavior":"allow"');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.input).toEqual({ command: "echo safe" });
    expect(seen[1]!.input).toEqual({ command: "echo safe" });
  }, 20_000);
});
