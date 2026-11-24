import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import * as procs from "../procs.ts";
import { createExecutors, shellQuote } from "./executors.ts";
import { startRun, type RunEnvelope } from "./runner.ts";

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish`)), 3_000); }),
  ]).finally(() => clearTimeout(timer));
}

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch {
    return false;
  }
}

it.runIf(process.platform === "linux").each(["abort", "overflow", "timeout"])("stops a shell command's child processes on %s", async (reason) => {
  const cwd = mkdtempSync(join(tmpdir(), "burger-shell-stop-"));
  const controller = new AbortController();
  const spawn = vi.spyOn(procs, "spawnCli");
  let child: ReturnType<typeof procs.spawnCli> | undefined;
  let helper = 0;
  let held: Socket | undefined;
  let closed: Promise<void> | undefined;
  let arrived!: (pid: number) => void;
  const ready = new Promise<number>((resolve) => { arrived = resolve; });
  let written!: () => void;
  const wrote = new Promise<string>((resolve) => { written = () => resolve("wrote"); });
  const server = createServer((socket) => {
    held = socket;
    // The stopped child resets its connection; that reset is the expected outcome, not a test error.
    socket.on("error", () => {});
    closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    let line = "";
    socket.on("data", (chunk) => {
      line += String(chunk);
      if (line.includes("\n")) arrived(Number(line.split("\n")[0]));
      if (line.includes("\nwrote\n")) written();
    });
  });
  let running: ReturnType<ReturnType<typeof createExecutors>["shell"]> | undefined;
  let workflowRun: Promise<RunEnvelope> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const action = reason === "timeout" ? "require('node:fs').writeFileSync('after-timeout.txt', 'still running'); socket.write('wrote\\n');" : "process.stdout.write('x'.repeat(2048));";
    const script = `const socket = require('node:net').connect(${port}, '127.0.0.1', () => socket.write(process.pid + '\\n')); socket.once('data', () => { ${action} }); setInterval(() => {}, 1000);`;
    const exec = createExecutors({ botId: "shell-reporter", cwd, internal: async () => ({ ok: false, body: {} }) });
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)} & wait`;
    if (reason === "timeout") {
      const workflow = workflowSchema.parse({ version: 1, summary: "Run a command", args: {}, steps: [
        { id: "shell", kind: "shell", label: "Run child command", run: command, timeoutMs: 2_000 },
        { id: "later", kind: "file", label: "Finish", path: "later.txt", content: "done" },
      ] });
      workflowRun = startRun({ name: "child-command", botId: "shell-reporter", threadId: "t", sha256: "fixture", workflow }, {
        exec: { ...exec, shell: (input) => { running = exec.shell(input); return running; } },
        events: { started: () => {}, ended: () => {} }, save: () => {},
      });
    } else {
      running = exec.shell({ command, env: {}, where: "bot", tool: "shell", signal: controller.signal, maxBytes: 1_024 });
    }
    helper = await bounded(ready, "command startup");
    child = spawn.mock.results.find((result) => result.type === "return")?.value;
    expect(child).toBeDefined();
    procs.captureCliTree(child!);
    expect(alive(helper)).toBe(true);
    if (reason === "timeout") {
      expect(await bounded(workflowRun!, "workflow timeout")).toMatchObject({ ok: false, error: { type: "timeout", step: "shell" } });
      expect(existsSync(join(cwd, "later.txt"))).toBe(false);
      if (!held!.destroyed) held!.write("go");
      const after = await bounded(Promise.race([wrote, closed!.then(() => "closed")]), "child after timeout");
      expect(existsSync(join(cwd, "after-timeout.txt"))).toBe(false);
      expect(after).toBe("closed");
    } else {
      if (reason === "abort") controller.abort();
      else held!.write("go");
      const result = await bounded(running!, "stopped command");
      expect(result).toMatchObject(reason === "overflow" ? { ok: false, tooLarge: true } : { ok: false });
      await bounded(closed!, "child connection close");
    }
    expect(alive(helper)).toBe(false);
  } finally {
    controller.abort();
    child ??= spawn.mock.results.find((result) => result.type === "return")?.value;
    if (child) await procs.killCliTree(child, 0);
    if (helper && alive(helper)) { try { process.kill(helper, "SIGKILL"); } catch {} }
    held?.destroy();
    if (running) await bounded(running, "command cleanup").catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    spawn.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
  }
});
