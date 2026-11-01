// A bot's question from inside a real box, where one can run: Linux with an unprivileged bubblewrap (a Cloud home, the Fly
// test machine). The question tool's helper (permission-proxy.ts) runs in the box with the engine and reaches the broker
// through the socket the driver puts back. Elsewhere the suite says so and skips, like the box's own self-check.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createPermissionBroker } from "../drivers/claude.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { defaultCodeRoots } from "./box.ts";
import { detectBox } from "./detect.ts";
import { bwrapArgs, planBox } from "./plan.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const available = detection.box === "bwrap" && detection.tools !== null;
const root = mkdtempSync(join(tmpdir(), "omb-box-ask-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home"), dataDir = join(home, ".openmausbot"), cwd = join(dataDir, "task-workspaces", "bot-a", "t-1");
const env = { PATH: "/usr/bin:/bin", HOME: home };

/** One ask_user call through the helper in a box that puts back `rw`; the helper's MCP result. */
function askInBox(socket: string, rw: string[]): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  const plan = planBox({ dataDir, home, codeRoots: defaultCodeRoots(), engineRoots: [], bridges: [] }, { command: process.execPath, args: [], cwd, env, rw });
  const child = spawn(detection.tools!.bwrap, [...bwrapArgs(plan), "--", process.execPath, SPAWNED_PROXIES.permission, socket], { env, stdio: ["pipe", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no answer from the helper in the box: ${out}`)); }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const reply = out.split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((msg) => msg?.id === 1);
      if (!reply) return;
      clearTimeout(timer);
      child.kill();
      resolve(reply.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_user", arguments: { question: "Which account?" } } }) + "\n");
  });
}

describe.skipIf(!available)(`a bot's question from inside a real box (${available ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  it("reaches the broker through the socket put back in the box, and says what to do instead without it", async () => {
    mkdirSync(cwd, { recursive: true });
    const asked: string[] = [];
    const broker = await createPermissionBroker({
      socketPaths: [join(dataDir, "perm-test.sock")],
      onAsk: (ask) => {
        asked.push(String(ask.input.question));
        broker.answer(ask.id, "answer", "Work");
      },
      onResolve: () => {},
    });
    try {
      expect(await askInBox(broker.socketPath, [broker.socketPath])).toEqual({ content: [{ type: "text", text: "Work" }] });
      expect(asked).toEqual(["Which account?"]);
      const hidden = await askInBox(broker.socketPath, []);
      expect(hidden.isError).toBe(true);
      expect(hidden.content[0]!.text).toContain("could not show this question to the person");
      expect(asked).toHaveLength(1);
    } finally {
      broker.close();
    }
  }, 60_000);
});
