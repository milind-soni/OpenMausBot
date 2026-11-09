import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { waitForExit } from "./testing/cleanup.ts";

it.each([false, true])("resumes a delegated task after a real background exit, validates its artifact, and reports once without a new user message (room=%s)", async room => {
  const boxes: Array<{ id: string; name: string; state: string }> = [];
  const jobs: Array<{ child: ChildProcess; closed: Promise<unknown[]>; artifact: string; stdout: string; exitCode: number | null; running: boolean }> = [];
  const validations: number[] = [];
  const requests: unknown[] = [];
  let dataDir = "";
  let statusStarted: (() => void) | undefined;
  let statusGate: Promise<void> | undefined;
  let releaseStatus: (() => void) | undefined;
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, path, body });
    const send = (value: unknown) => res.end(JSON.stringify(value));
    res.setHeader("content-type", "application/json");
    if (path === "/sandboxes" && req.method === "POST") {
      const box = { id: `bx_${(0x23456789 + boxes.length).toString(16)}`, name: body.name, state: "idle" };
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
      statusStarted?.();
      await statusGate;
      const job = jobs[Number(status[1]) - 1];
      if (job.running) await job.closed;
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
      const group = room ? (await api("POST", "/api/groups", { name: `Command room ${id}`, memberIds: [worker.id] })).group : undefined;
      if (group) await api("PATCH", `/api/groups/${group.id}/setup`, { action: "skip" });
      writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
        [owner.id]: { steps: [{ arguments: { bot_ids: [worker.id], ...(group ? { group_id: group.id } : {}), message: `Run background fixture ${id}` } }], reply: "Assigned the work", resumeReply: `Checked result ${id}` },
        [worker.id]: { script: [
          { key: "start", match: [`Run background fixture ${id}`], steps: [{ server: "computer", tool: "exec", arguments: { command: `background-fixture-${id}`, background: true } }], reply: "The command is still running" },
          { key: "validate", match: ["A background command for this task ended."], expectContextIncludes: ["terminal result · information only", "exitCode", "(From a person", "validate the artifacts"],
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
      if (room) await expect.poll(() => validations, { timeout: 20_000 }).toContain(id);
      const wait = await control("wait", "--bot", owner.id, "--task", owner.activeTaskId, "--timeout", "40");
      expect(wait.status, JSON.stringify(wait)).toBe("settled");
      expect(validations.filter(value => value === id), JSON.stringify(readHandoffs(dataDir))).toHaveLength(1);
      const messages = await control("messages", "--bot", owner.id, "--task", owner.activeTaskId, "--limit", "30");
      const rows = readHandoffs(dataDir);
      expect(rows.find(n => n.botId === worker.id)).toMatchObject({ status: "completed", executions: 2, result: `Validated terminal exit ${exitCode}` });
      expect(rows.filter(n => n.botId === owner.id)).toMatchObject([{ status: "completed", executions: 2 }]);
      expect(JSON.stringify(messages)).toContain(`Checked result ${id}`);
      evidence.push({ room, exitCode, wait, messages, rows, validations: [...validations] });
    }
    if (!room) for (const phase of ["before-poll", "in-flight", "team-unassigned"]) {
      const id = jobs.length + 1;
      const { bot: owner } = await control("new-bot", "--name", `Permission owner ${id}`, "--section", "Team");
      const { bot: worker } = await control("new-bot", "--name", `Permission worker ${id}`, "--section", "Team");
      await api("PATCH", `/api/bots/${owner.id}`, { chiefOfStaff: true, managedSections: ["Team"], acknowledgePeerScope: true, approvalMode: "full", computer: "off" });
      await api("PATCH", `/api/bots/${worker.id}`, { ...(phase === "team-unassigned" ? {} : { computer: "cloud" }), browser: false, approvalMode: "full" });
      const computer = phase === "team-unassigned" ? await api("POST", "/api/team-computers", { name: "Fixture shared computer", requestId: randomUUID(), acknowledgeCost: true }) : undefined;
      if (computer) await api("PATCH", `/api/team-computers/${computer.id}`, { section: "Team", acknowledgeSharedAccess: true });
      let reading = false;
      statusStarted = () => { reading = true; };
      statusGate = phase !== "before-poll" ? new Promise<void>(resolve => { releaseStatus = resolve; }) : undefined;
      writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
        [owner.id]: { steps: [{ arguments: { bot_ids: [worker.id], message: `Permission fixture ${id}` } }], reply: "Assigned", resumeReply: "Reported revoked access" },
        [worker.id]: { steps: [{ server: "computer", tool: "exec", arguments: { command: `permission-fixture-${id}`, background: true } }], reply: "The command is still running" },
      }));
      await control("send", "--bot", owner.id, "--task", owner.activeTaskId, "--text", `Permission fixture ${id}`);
      await expect.poll(() => readHandoffs(dataDir).find(n => n.botId === worker.id)?.status, { timeout: 10_000 }).toBe("waiting");
      if (phase !== "before-poll") await expect.poll(() => reading, { timeout: 10_000 }).toBe(true);
      if (computer) await api("PATCH", `/api/team-computers/${computer.id}`, { section: null, acknowledgeSharedAccess: true });
      else await api("PATCH", `/api/bots/${worker.id}`, { computer: "off" });
      const readsAtRevocation = requests.filter((request: any) => /\/commands\/\d+$/.test(request.path)).length;
      jobs[id - 1]!.child.send!(7); await jobs[id - 1]!.closed;
      releaseStatus?.(); releaseStatus = undefined; statusGate = undefined; statusStarted = undefined;
      await expect.poll(() => readHandoffs(dataDir).find(n => n.botId === worker.id)?.status, { timeout: 10_000 }).toBe("failed");
      const wait = await control("wait", "--bot", owner.id, "--task", owner.activeTaskId, "--timeout", "10");
      expect(wait.status).toBe("settled");
      const db = new DatabaseSync(join(dataDir, "runtime.db"), { readOnly: true });
      try {
        const rows = (db.prepare("SELECT json FROM assignments WHERE assignee_bot_id = ?").all(worker.id) as Array<{ json: string }>).map(row => JSON.parse(row.json));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "failed", outcome: "refused", executions: 1 });
        expect(rows[0].backgroundCommands[0].result).toBeUndefined();
        if (computer) expect(rows[0].backgroundCommands[0].teamComputerId).toBe(computer.id);
        expect(requests.filter((request: any) => /\/commands\/\d+$/.test(request.path))).toHaveLength(readsAtRevocation);
        expect(validations).not.toContain(id);
        evidence.push({ phase, wait, rows, readsAtRevocation, exitCode: jobs[id - 1]!.exitCode });
      } finally { db.close(); }
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
    if (!room) expect(plans.some(turn => JSON.stringify(turn.evidence).includes("Only the person can set up or stop a wait"))).toBe(true);
    evidence.push({ plans });
  } finally {
    try {
      const planPath = join(dataDir, "room-plan.json.evidence.jsonl");
      const plans = existsSync(planPath) ? readFileSync(planPath, "utf8") : "";
      const rows = readHandoffs(dataDir);
      const messages = await Promise.all(rows.map(n => control("messages", ...(n.groupId ? ["--channel", n.groupId] : ["--bot", n.botId]), "--task", n.threadId, "--limit", "30").catch(error => String(error))));
      const db = new DatabaseSync(join(dataDir, "runtime.db"), { readOnly: true });
      let assignments: unknown[];
      try { assignments = (db.prepare("SELECT json FROM assignments").all() as Array<{ json: string }>).map(row => JSON.parse(row.json)); }
      finally { db.close(); }
      writeFileSync(`${fixture.info.logPath}.background.json`, JSON.stringify({ evidence, validations, rows, assignments, plans, messages, requests }, null, 2));
    } finally {
      releaseStatus?.();
      for (const job of jobs) await waitForExit(job.child, { signal: "SIGTERM", graceMs: 1_000 });
      await fixture.close(); upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      writeFileSync(`${fixture.info.logPath}.exits.json`, JSON.stringify({
        server: { argv: fixture.child.spawnargs, exitCode: fixture.child.exitCode, signal: fixture.child.signalCode },
        commands: jobs.map(job => ({ argv: job.child.spawnargs, exitCode: job.child.exitCode, signal: job.child.signalCode })),
      }, null, 2));
    }
  }
}, 120_000);
