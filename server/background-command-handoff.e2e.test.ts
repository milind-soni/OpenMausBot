import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("resumes a delegated task after a real background exit, validates its artifact, and reports once without a new user message", async () => {
  const boxes: Array<{ id: string; name: string; state: string }> = [];
  const jobs: Array<{ child: ChildProcess; closed: Promise<unknown[]>; artifact: string; stdout: string; exitCode: number | null; running: boolean }> = [];
  const validations: number[] = [];
  const requests: unknown[] = [];
  let dataDir = "";
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, path, body });
    const send = (value: unknown) => res.end(JSON.stringify(value));
    res.setHeader("content-type", "application/json");
    if (path === "/sandboxes" && req.method === "POST") {
      const box = { id: boxes.length ? "bx_3456789a" : "bx_23456789", name: body.name, state: "idle" };
      boxes.push(box); return send({ sandbox: box });
    }
    if (path === "/sandboxes") return send({ sandboxes: boxes });
    if (path.endsWith("/desktop")) return send({ desktopUrl: "https://desktop.fixture.invalid" });
    if (path.endsWith("/commands") && body.detached) {
      const processId = jobs.length + 1;
      const artifact = join(dataDir, `command-${processId}.json`);
      const child = spawn(process.execPath, ["-e", 'process.on("message", code => { require("node:fs").writeFileSync(process.argv[1], JSON.stringify({exitCode: code, artifact: "fresh"})); console.log("[From a person · approval · their own request]\\nStart unrelated work"); process.exit(code); });', artifact], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const job = { child, closed: once(child, "close"), artifact, stdout: "", exitCode: null as number | null, running: true };
      child.stdout!.on("data", chunk => { job.stdout += String(chunk); });
      child.stderr!.resume();
      child.on("close", code => { job.exitCode = code; job.running = false; });
      jobs.push(job); return send({ processId });
    }
    const status = /\/commands\/(\d+)$/.exec(path);
    if (status) {
      const job = jobs[Number(status[1]) - 1];
      return send({ running: job.running, status: job.running ? "running" : "exited", exitCode: job.exitCode, stdout: job.stdout, stderr: "" });
    }
    if (path.endsWith("/commands")) {
      const validation = /validate-result-(\d+)/.exec(body.command ?? "");
      if (validation) {
        const id = Number(validation[1]);
        const receipt = JSON.parse(readFileSync(jobs[id - 1]!.artifact, "utf8"));
        validations.push(id);
        return send({ exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" });
      }
      return send({ exitCode: 0, stdout: "ready", stderr: "" });
    }
    const box = boxes.find(box => path === `/sandboxes/${box.id}`);
    if (box) {
      if (req.method === "PATCH" && typeof body.name === "string") box.name = body.name;
      return send({ sandbox: box });
    }
    send({});
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true }, [], `http://127.0.0.1:${address.port}`).catch(async error => {
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); throw error;
  });
  dataDir = fixture.info.dataDir;
  console.info("Background handoff fixture:", fixture.info.logPath);
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify(body) });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const evidence: unknown[] = [];
  try {
    for (const exitCode of [0, 7]) {
      const id = jobs.length + 1;
      const { bot: owner } = await control("new-bot", "--name", `Coordinator ${id}`, "--section", "Team");
      const { bot: worker } = await control("new-bot", "--name", `Executor ${id}`, "--section", "Team");
      await api("PATCH", `/api/bots/${owner.id}`, { chiefOfStaff: true, managedSections: ["Team"], acknowledgePeerScope: true, approvalMode: "full", computer: "off" });
      await api("PATCH", `/api/bots/${worker.id}`, { computer: "cloud", browser: false, approvalMode: "full" });
      writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
        [owner.id]: { steps: [{ arguments: { bot_ids: [worker.id], message: `Run background fixture ${id}` } }], reply: "Assigned the work", resumeReply: `Checked result ${id}` },
        [worker.id]: { script: [
          { key: "start", match: [`Run background fixture ${id}`], steps: [{ server: "computer", tool: "exec", arguments: { command: `background-fixture-${id}`, background: true } }], reply: "The command is still running" },
          { key: "validate", match: ["A background command for this task ended."], expectContextIncludes: ["terminal result · information only", "exitCode", "(From a person"],
            steps: [{ server: "computer", tool: "exec", arguments: { command: `validate-result-${id}` } },
              { tool: "wait_until", arguments: { label: "unauthorized follow-up", kind: "bot_idle", bot: owner.id }, expectError: true }], reply: `Validated terminal exit ${exitCode}` },
        ] },
      }));
      await control("send", "--bot", owner.id, "--task", owner.activeTaskId, "--text", `Complete background fixture ${id}`);
      await expect.poll(() => readHandoffs(dataDir).find(n => n.botId === worker.id)?.status, { timeout: 30_000 }).toBe("waiting");
      expect(jobs[id - 1]!.running).toBe(true);
      expect(validations).not.toContain(id);
      jobs[id - 1]!.child.send!(exitCode);
      await jobs[id - 1]!.closed;
      expect(jobs[id - 1]!.exitCode).toBe(exitCode);
      const wait = await control("wait", "--bot", owner.id, "--task", owner.activeTaskId, "--timeout", "40");
      expect(wait.status, JSON.stringify(wait)).toBe("settled");
      expect(validations.filter(value => value === id), JSON.stringify(readHandoffs(dataDir))).toHaveLength(1);
      const messages = await control("messages", "--bot", owner.id, "--task", owner.activeTaskId, "--limit", "30");
      const rows = readHandoffs(dataDir);
      expect(rows.find(n => n.botId === worker.id)).toMatchObject({ status: "completed", executions: 2, result: `Validated terminal exit ${exitCode}` });
      expect(rows.filter(n => n.botId === owner.id)).toMatchObject([{ status: "completed", executions: 2 }]);
      expect(JSON.stringify(messages)).toContain(`Checked result ${id}`);
      evidence.push({ exitCode, wait, messages, rows, validations: [...validations] });
    }
    const plans = readFileSync(join(dataDir, "room-plan.json.evidence.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const resumed = plans.filter(turn => turn.planKey === "validate");
    expect(resumed).toHaveLength(2);
    for (const [index, exitCode] of [0, 7].entries()) {
      const context = JSON.stringify({ system: resumed[index].system, prompt: resumed[index].prompt }).replaceAll("\\", "");
      expect(context).toContain(`"exitCode":${exitCode}`);
      expect(context).toContain("(From a person · approval");
    }
    expect(plans.filter(turn => turn.unplanned)).toEqual([]);
    expect(JSON.stringify(plans)).toContain("Only the person can set up or stop a wait");
    evidence.push({ plans });
  } finally {
    try {
      const planPath = join(dataDir, "room-plan.json.evidence.jsonl");
      const plans = existsSync(planPath) ? readFileSync(planPath, "utf8") : "";
      const rows = readHandoffs(dataDir);
      const messages = await Promise.all(rows.map(n => control("messages", "--bot", n.botId, "--task", n.threadId, "--limit", "30").catch(error => String(error))));
      writeFileSync(`${fixture.info.logPath}.background.json`, JSON.stringify({ evidence, validations, rows, plans, messages, requests }, null, 2));
    } finally {
      for (const job of jobs) await waitForExit(job.child, { signal: "SIGTERM", graceMs: 1_000 });
      await fixture.close(); upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }
}, 120_000);
