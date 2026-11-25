import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import type { AppConfig } from "../config.ts";
import { createExecutors, shellQuote } from "./executors.ts";
import { createRunStates } from "./run-state.ts";
import { startRun, type RunDeps, type RunEnvelope, type StepResult } from "./runner.ts";

const roots: string[] = [];
const children: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];
let respond: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let cloud: typeof import("../cloud-computer-tools.ts");
const fixtureErrors: unknown[] = [];
const server = createServer((req, res) => { void respond(req, res).catch((error) => {
  fixtureErrors.push(error);
  if (!res.headersSent) res.statusCode = 500;
  res.end(String(error));
}); });
const cfg = { box: { token: "synthetic-workflow-key" } } as AppConfig;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  vi.stubEnv("OMB_BOAT_API", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", undefined);
  cloud = await import("../cloud-computer-tools.ts");
});
afterEach(async () => {
  server.closeAllConnections();
  for (const { child, closed } of children.splice(0)) { if (child.exitCode === null) child.kill("SIGKILL"); await closed; }
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  expect(fixtureErrors.splice(0)).toEqual([]);
});
afterAll(async () => { vi.unstubAllEnvs(); await new Promise<void>((resolve) => server.close(() => resolve())); });

async function startedRun(exitCode = 0, options: { terminal?: "lost" | "unknown" | "missing"; foreground?: boolean; timeoutMs?: number; notes?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "burger-cloud-command-"));
  roots.push(root);
  const worker = join(root, "worker.mjs");
  writeFileSync(worker, `import { writeFileSync } from 'node:fs';
process.stdout.write('building');
process.stdin.once('data', () => {
  writeFileSync('artifact.txt', 'complete');
  process.stdout.write('\\nartifact complete');
  if (${exitCode} !== 0) process.stderr.write('build failed');
  process.exit(${exitCode});
});`);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let child: ChildProcessWithoutNullStreams;
  let closed: Promise<void>;
  let stdout = "", stderr = "";
  let statusReads = 0, starts = 0;
  let followed!: () => void;
  const following = new Promise<void>((resolve) => { followed = resolve; });
  let releaseStatus!: () => void;
  const statusReleased = new Promise<void>((resolve) => { releaseStatus = resolve; });
  respond = async (req, res) => {
    res.setHeader("connection", "close");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, "http://boat.test");
    const send = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
    if (req.method === "POST" && url.pathname === "/sandboxes/bx_23456789/commands") {
      const body = JSON.parse(raw) as { command: string; detached?: boolean };
      if (body.command === "true" && !body.detached) return send({ exitCode: 0, stdout: "", stderr: "" });
      expect(body.detached).toBe(true);
      expect(body.command).toContain(worker);
      starts += 1;
      child = spawn("/bin/sh", ["-c", body.command], { cwd: root, env: { HOME: root, PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      children.push({ child, closed });
      await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", (code) => { if (code !== null) reject(new Error(`worker exited before release: ${code}; ${stderr}`)); }); });
      if (options.foreground) { child.stdin.end("finish"); await closed; return send({ exitCode: child.exitCode, stdout, stderr }); }
      return send({ processId: child.pid });
    }
    if (req.method === "GET" && url.pathname === `/sandboxes/bx_23456789/commands/${child!.pid}`) {
      statusReads += 1;
      if (statusReads === 1) {
        now += 33_000;
        return send({ running: true, status: "running", stdout, stderr });
      }
      followed();
      await statusReleased;
      await closed!;
      if (options.terminal === "missing") { res.statusCode = 404; return send({ error: "No such process" }); }
      return send({ running: false, status: options.terminal === "lost" ? "lost" : "exited", exitCode: options.terminal ? null : child!.exitCode, stdout, stderr });
    }
    res.writeHead(404); res.end();
  };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const results: Record<string, StepResult> = {};
  const abort = new AbortController();
  const exec = createExecutors({ botId: "builder", cwd: root, async internal(kind, path, body, signal) {
    if (kind === "agents") {
      expect(path).toBe("/api/internal/vm-exec");
      return { ok: false, status: 409, body: { code: "no_vm_for_turn", error: "No Local VM in this fixture" } };
    }
    expect(kind).toBe("computer");
    expect(path).toBe("/api/internal/computer/mcp");
    const frame = body as { method: string; params: { name: string; arguments: Record<string, unknown> } };
    calls.push({ name: frame.params.name, args: frame.params.arguments });
    const result = await cloud.cloudComputerRpc(frame, {
      cfg, boxId: () => "bx_23456789", signal, budgetMs: 32_000,
      gate: async () => ({ held: false }), assertActive: () => signal.throwIfAborted(),
      ...(options.notes ? { disk: { began() {}, ended() {}, after: async () => "Disk note: space is running low." } } : {}),
    });
    return { ok: true, body: { result } };
  } });
  const deps: RunDeps = { exec, signal: abort.signal, events: { started() {}, ended: (_id, _name, step, result) => { results[step.id] = result; } }, save: (state) => createRunStates(join(root, "states")).save(state) };
  const workflow = workflowSchema.parse({ version: 1, summary: "Build and publish the artifact", args: {}, steps: [
    { id: "build", kind: "shell", where: "vm", label: "Build the artifact", run: `exec ${shellQuote(process.execPath)} ${shellQuote(worker)}`, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
    { id: "publish", kind: "file", label: "Publish completion", path: "published.txt", content: "complete" },
  ] });
  const running = startRun({ name: "build", botId: "builder", threadId: "build-thread", sha256: "fixture", workflow }, deps);
  const observed = await Promise.race([following.then(() => "following" as const), running.then((envelope) => envelope)]);
  return {
    observed, running, calls, results, abort,
    starts: () => starts,
    release: async () => { child!.stdin.end("finish"); await closed!; releaseStatus(); },
    artifact: () => existsSync(join(root, "artifact.txt")),
    published: () => existsSync(join(root, "published.txt")),
    contents: () => readFileSync(join(root, "published.txt"), "utf8"),
  };
}

it.skipIf(process.platform === "win32").each([false, true])("waits for the original cloud process before publishing the completed artifact (disk note: %s)", async (notes) => {
  const h = await startedRun(0, { notes });
  try {
    expect(h.artifact()).toBe(false);
    expect(h.published()).toBe(false);
    expect(h.observed).toBe("following");
  } finally { await h.release(); }
  expect(await h.running).toMatchObject({ ok: true, status: "ok" });
  expect(h.artifact()).toBe(true);
  expect(h.contents()).toBe("complete");
  expect(h.starts()).toBe(1);
  expect(h.calls.map((call) => call.name)).toEqual(["exec", "exec_status"]);
  expect(h.results.build).toMatchObject({ state: "done", output: { status: "finished", exitCode: 0, stdout: expect.stringContaining("artifact complete") } });
});

it.skipIf(process.platform === "win32")("does not publish when the followed process exits unsuccessfully", async () => {
  const h = await startedRun(7);
  try {
    expect(h.artifact()).toBe(false);
    expect(h.published()).toBe(false);
    expect(h.observed).toBe("following");
  } finally { await h.release(); }
  const done: RunEnvelope = await h.running;
  expect(done).toMatchObject({ ok: false, error: { type: "step_failed", step: "build", message: expect.stringContaining("build failed"), resumeToken: done.run } });
  expect(h.published()).toBe(false);
  expect(h.starts()).toBe(1);
});

it.skipIf(process.platform === "win32").each(["lost", "unknown", "missing"] as const)("does not publish when the provider reports the followed command as %s", async (terminal) => {
  const h = await startedRun(0, { terminal });
  try { expect(h.observed).toBe("following"); } finally { await h.release(); }
  expect(await h.running).toMatchObject({ ok: false, error: { type: "step_failed", step: "build" } });
  expect(h.published()).toBe(false);
  expect(h.starts()).toBe(1);
});

it.skipIf(process.platform === "win32")("keeps the completed foreground-relay path without status polling", async () => {
  const h = await startedRun(0, { foreground: true });
  expect(h.observed).toMatchObject({ ok: true, status: "ok" });
  expect(h.artifact()).toBe(true);
  expect(h.contents()).toBe("complete");
  expect(h.starts()).toBe(1);
  expect(h.calls.map((call) => call.name)).toEqual(["exec"]);
});

it.skipIf(process.platform === "win32")("stops following on caller cancellation without publishing or starting again", async () => {
  const h = await startedRun();
  expect(h.observed).toBe("following");
  const stopped = expect(h.running).resolves.toMatchObject({ ok: true, status: "cancelled" });
  h.abort.abort();
  await stopped;
  expect(h.artifact()).toBe(false);
  expect(h.published()).toBe(false);
  expect(h.starts()).toBe(1);
  expect(h.calls.map((call) => call.name)).toEqual(["exec", "exec_status"]);
  await h.release();
});

it.skipIf(process.platform === "win32")("honors the step deadline while status is pending and never runs the consumer", async () => {
  const h = await startedRun(0, { timeoutMs: 5_000 });
  try {
    expect(h.observed).toBe("following");
    expect(await h.running).toMatchObject({ ok: false, error: { type: "timeout", step: "build", message: expect.stringContaining("cloud command may still be running") } });
    expect(h.artifact()).toBe(false);
    expect(h.published()).toBe(false);
    expect(h.starts()).toBe(1);
    expect(h.calls.map((call) => call.name)).toEqual(["exec", "exec_status"]);
  } finally { await h.release(); }
});
