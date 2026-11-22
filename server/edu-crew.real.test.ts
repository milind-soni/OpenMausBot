// Runs only where Edu 6+ is installed (CI has none). Edu is real; its crew CLI is a fake `codex` on PATH, so no real
// coding CLI, account or key is ever used. Every brain and folder is temporary.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { OptionCardData } from "../shared/wire.ts";
import { createEduBrains, locateEduCli } from "./edu-brain.ts";
import { createEduCrew, type EduCrewDeps } from "./edu-crew.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const cli = locateEduCli({ PATH: process.env.PATH }, process.env.PATH ?? "");
const root = mkdtempSync(join(tmpdir(), "edu-crew-real-"));
const realEdu = join(homedir(), ".edu");
const realMtime = () => (existsSync(realEdu) ? statSync(realEdu).mtimeMs : null);
const before = realMtime();
afterAll(() => {
  removeTempDir(root);
  expect(realMtime()).toBe(before);
});

const HANG_PIDS = join(root, "hang-pids.json");
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  if (input.includes("HANG_FOREVER")) {
    const child = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
    fs.writeFileSync(${JSON.stringify(HANG_PIDS)}, JSON.stringify({ codex: process.pid, child: child.pid }));
    setInterval(() => {}, 1e6);
    return;
  }
  let text = "FAKE REVIEW: no findings";
  if (input.includes("Create a safe, concise execution plan")) text = JSON.stringify({ requirements: [{ id: "R-1", text: "hello.txt exists" }], checks: [], steps: [{ id: "s1", role: "builder", task: "Write hello.txt", dependsOn: [], parallelSafe: false }] });
  else if (input.includes('Return strict JSON {"verdict"')) text = JSON.stringify({ verdict: "pass", issues: [] });
  else if (process.argv.includes("workspace-write")) fs.writeFileSync("hello.txt", "hi\\n");
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
});
`;

describe.skipIf(!cli || process.platform === "win32")("Edu crew with the installed Edu binary and a fake crew CLI", () => {
  const dataDir = join(root, "data"), home = join(root, "home"), project = join(home, "Projects", "shop"), bin = join(root, "bin");
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), FAKE_CODEX, { mode: 0o755 });
  execFileSync("git", ["init", "-q"], { cwd: project });
  const path = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
  const env: NodeJS.ProcessEnv = { PATH: path, HOME: home, USERPROFILE: home, OMB_EDU_CLI: cli!, LANG: "C" };
  const brains = createEduBrains({ dataDir, config: () => ({ home: join(home, ".edu") }), env });
  const bot = { id: "bot-real", name: "Luna", color: "blue", threadId: "t-1", eduCrew: true };
  const threads = new Map<string, Array<{ id: string; card?: OptionCardData; eduCrew?: { status: string }; tool?: { name: string } }>>();
  let next = 0;
  const linked = join(home, "Projects", "linked");
  mkdirSync(linked, { recursive: true });
  symlinkSync(join(home, ".edu"), join(linked, ".edu"));
  const deps: EduCrewDeps = {
    dataDir, brains, env, path: () => path, desktop: true, decide: () => {},
    folder: (_botId, threadId) => (threadId === "t-linked" ? linked : project), engine: () => "claudeAgent",
    turn: () => ({ room: false, hostLocal: true, confined: false, computer: "local" }), pollMs: 200,
    store: {
      bot: (id) => (id === bot.id ? bot : null),
      messagesFor: (threadId) => threads.get(threadId) ?? [],
      appendMessage: (threadId, message) => { const row = { ...message, id: `m${++next}` }; threads.set(threadId, [...(threads.get(threadId) ?? []), row as never]); return row; },
      patchMessage: (threadId, id, patch) => { threads.set(threadId, (threads.get(threadId) ?? []).map((row) => (row.id === id ? { ...row, ...patch } : row))); },
    },
  };
  const crew = createEduCrew(deps);
  afterAll(() => crew.stop());

  async function ask(body: object, threadId = "t-1") {
    let sent: { status: number; body: { text?: string; error?: string } } | null = null;
    await crew.internal({ method: "POST", path: "/api/internal/edu/crew", res: {}, json: (_res, status, payload) => { sent = { status, body: payload as never }; }, botId: bot.id, threadId, readBody: async () => body });
    return sent!;
  }
  const rows = (threadId: string) => threads.get(threadId) ?? [];
  const openGate = (threadId: string) => rows(threadId).find((row) => row.card?.eduCrewGate && !row.card.answered);
  const line = (threadId: string) => rows(threadId).find((row) => row.eduCrew)!;
  async function until(check: () => boolean, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out; rows: ${JSON.stringify(rows("t-1").concat(rows("t-2")).map((row) => row.tool?.name ?? row.card?.eduCrewGate?.gate))}`);
      await crew.tick();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  it("plans, waits at every gate for a person, builds in the project folder and ends done", async () => {
    const started = await ask({ action: "plan", goal: "Add a hello file" });
    expect(started.body.error).toBeUndefined();
    const jobId = /job ([a-f0-9-]{36})/.exec(started.body.text!)![1]!;
    const record = JSON.parse(readFileSync(join(dataDir, "brains", bot.id, ".edu", "crew", `${jobId}.json`), "utf8")) as { autoApprove: boolean; allowUnregisteredChecks: boolean; cwd: string };
    expect(record).toMatchObject({ autoApprove: false, allowUnregisteredChecks: false, cwd: project });

    await until(() => Boolean(openGate("t-1")));
    const spec = openGate("t-1")!.card!;
    expect(spec.eduCrewGate).toMatchObject({ gate: "Approve spec", folder: project });
    expect(spec.eduCrewGate!.spec).toContain("hello.txt exists");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await crew.tick();
    expect(existsSync(join(project, "hello.txt"))).toBe(false);
    expect(line("t-1").eduCrew!.status).toBe("waiting");

    expect(await crew.resolve("t-1", spec.requestId!, "allow")).toEqual({ ok: true, outcome: "allowed-once" });
    await until(() => Boolean(openGate("t-1")));
    const step = openGate("t-1")!.card!;
    expect(step.eduCrewGate!.gate).toBe("Approve builder step");
    expect(await crew.resolve("t-1", step.requestId!, "allow")).toEqual({ ok: true, outcome: "allowed-once" });
    await until(() => line("t-1").eduCrew!.status === "done");
    expect(readFileSync(join(project, "hello.txt"), "utf8")).toBe("hi\n");
    expect((await ask({ action: "result", job_id: jobId })).body.text).toMatch(/done/);
  }, 90_000);

  it("a rejected spec fails the job without building", async () => {
    await ask({ action: "plan", goal: "Add a second file" }, "t-2");
    await until(() => Boolean(openGate("t-2")));
    expect(await crew.resolve("t-2", openGate("t-2")!.card!.requestId!, "deny")).toEqual({ ok: true, outcome: "rejected" });
    await until(() => line("t-2").eduCrew!.status === "failed");
    expect(line("t-2").tool!.name).toMatch(/spec rejected/);
  }, 90_000);

  it("stopping the turn cancels the job in Edu", async () => {
    const started = await ask({ action: "plan", goal: "Something long" }, "t-3");
    const jobId = /job ([a-f0-9-]{36})/.exec(started.body.text!)![1]!;
    await until(() => Boolean(openGate("t-3")));
    await crew.stopped("t-3");
    expect(line("t-3").eduCrew!.status).toBe("cancelled");
    const record = JSON.parse(readFileSync(join(dataDir, "brains", bot.id, ".edu", "crew", `${jobId}.json`), "utf8")) as { status: string };
    expect(record.status).toBe("cancelled");
  }, 90_000);

  it("reviews read-only with another vendor's CLI and returns its words", async () => {
    const answer = await ask({ action: "review", question: "Is hello.txt right?", wait_seconds: 60 }, "t-4");
    expect(answer.body.error).toBeUndefined();
    expect(answer.body.text).toContain("FAKE REVIEW: no findings");
    expect(line("t-4").eduCrew).toMatchObject({ status: "done", kind: "review", cli: "codex" });
  }, 90_000);

  it("refuses a work folder whose .edu links into the global brain, and writes nothing there", async () => {
    mkdirSync(join(home, ".edu"), { recursive: true });
    const answer = await ask({ action: "plan", goal: "Escape" }, "t-linked");
    expect(answer.status).toBe(409);
    expect(answer.body.error).toMatch(/global Edu brain|\.edu is a link/);
    expect(existsSync(join(home, ".edu", "crew"))).toBe(false);
  });

  it("quitting cancels running jobs and ends their process trees; a crash leaves them for the next start", async () => {
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const answer = await ask({ action: "review", question: "HANG_FOREVER", wait_seconds: 0 }, "t-5");
    expect(answer.body.error).toBeUndefined();
    const jobId = /job ([a-f0-9-]{36})/.exec(answer.body.text!)![1]!;
    await until(() => existsSync(HANG_PIDS));
    const { codex, child } = JSON.parse(readFileSync(HANG_PIDS, "utf8")) as { codex: number; child: number };
    const record = () => JSON.parse(readFileSync(join(dataDir, "brains", bot.id, ".edu", "crew", `${jobId}.json`), "utf8")) as { status: string; pid?: number };
    const worker = record().pid;
    expect([codex, child, ...(worker ? [worker] : [])].every(alive)).toBe(true);

    crew.stop();
    const next = createEduCrew(deps);
    next.resume();
    await next.tick();
    expect(next.details(jobId)!.line.status).toBe("running");
    await next.shutdown();
    expect(next.details(jobId)!.line.status).toBe("cancelled");
    expect(record().status).toBe("cancelled");
    const deadline = Date.now() + 10_000;
    while ([codex, child, ...(worker ? [worker] : [])].some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    expect({ codex: alive(codex), child: alive(child), worker: worker ? alive(worker) : false }).toEqual({ codex: false, child: false, worker: false });
  }, 90_000);
});
