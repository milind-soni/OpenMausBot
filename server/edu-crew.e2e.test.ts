// A real server, the fake Claude engine, the real installed Edu (skipped where none is installed, as on CI) and a fake
// `codex` as Edu's only crew CLI, so no real coding CLI, account or key is used. A bot hands a goal to Edu crew; a person
// passes each gate; stopping a turn stops its job. HOME, the global Edu brain, the data folder and the project are
// temporary.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { locateEduCli } from "./edu-brain.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const cli = locateEduCli({ PATH: process.env.PATH }, process.env.PATH ?? "");

const fakeCodex = (pids: string) => `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] !== "exec") { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  if (input.includes("HANG_FOREVER")) {
    const child = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
    fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ codex: process.pid, child: child.pid }));
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

const client = (fixture: VerificationServer, token?: string) => async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};

function realBrainTimes(): string {
  const root = join(homedir(), ".edu");
  const walk = (dir: string, depth: number): string[] => {
    try {
      return [`${dir} ${statSync(dir).mtimeMs}`, ...(depth > 0 ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        .flatMap((entry) => walk(join(dir, entry.name), depth - 1)) : [])];
    } catch {
      return [];
    }
  };
  return walk(root, 3).join("\n");
}

async function until<T>(read: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((done) => setTimeout(done, 300));
  }
}

it.skipIf(!cli || process.platform === "win32")("a bot's Edu crew job waits at every gate for a person, builds in the project folder, and stops with the turn", async () => {
  const before = realBrainTimes();
  const scratch = mkdtempSync(join(tmpdir(), "edu-crew-e2e-"));
  const eduHome = join(scratch, "edu-home"), crewBin = join(scratch, "bin"), project = join(scratch, "project"), calls = join(scratch, "calls.json"), release = join(scratch, "release"), pids = join(scratch, "codex-pids.json");
  for (const dir of [eduHome, crewBin, project]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(crewBin, "codex"), fakeCodex(pids), { mode: 0o755 });
  symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(crewBin, "git"));
  execFileSync("git", ["init", "-q"], { cwd: project });
  writeFileSync(join(project, "README.md"), "shop\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "add", "README.md"], { cwd: project });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "start"], { cwd: project });
  const script = (value: unknown[]) => writeFileSync(calls, JSON.stringify(value));
  const plan = (goal: string) => ({ server: "agents", name: "edu_plan", input: { goal } });
  script([plan("Add a hello file")]);
  const fixture = await launchVerificationServer({ EDU_FIXTURE_HOME: eduHome, EDU_FIXTURE_CREW_BIN: crewBin, OMB_EDU_CLI: cli!, FAKE_CLAUDE_TOOL_CALLS_FILE: calls, FAKE_CLAUDE_RELEASE: release });
  const api = client(fixture);
  let closed = false;
  const turn = async (botId: string, threadId: string, text: string) => {
    await runControlOmb(["send", "--bot", botId, "--task", threadId, "--text", text, "--url", fixture.info.url]);
    await runControlOmb(["wait", "--bot", botId, "--timeout", "90", "--url", fixture.info.url]);
  };
  try {
    const created = await api("POST", "/api/bots", { name: "Luna" });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const bot = created.body.bot;
    const opened = await api("POST", "/api/auth/pairing", { label: "Owner phone", scopes: ["admin", "client"] });
    const owner = client(fixture, (await api("POST", "/api/auth/pair", { code: opened.body.code })).body.token);
    const moved = await owner("PATCH", `/api/bots/${bot.id}`, { cwd: project });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const rows = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages as any[];
    const gates = async () => (await rows()).filter((row) => row.card?.eduCrewGate);
    const lines = async () => (await rows()).filter((row) => row.eduCrew);

    await turn(bot.id, bot.threadId, "Build it with Edu crew");
    expect(await lines()).toEqual([]);

    const refused = await api("PATCH", `/api/bots/${bot.id}`, { eduCrew: true });
    expect(refused.status).toBe(403);
    expect((await owner("PATCH", `/api/bots/${bot.id}`, { eduCrew: true })).status).toBe(200);
    const view = await owner("GET", `/api/bots/${bot.id}/edu`);
    expect(view.body.crew).toEqual({ enabled: true, folder: project });

    await turn(bot.id, bot.threadId, "Build it with Edu crew");
    const line = await until(async () => (await lines())[0]);
    expect(line.eduCrew).toMatchObject({ kind: "plan", title: "Add a hello file" });
    const jobId = line.eduCrew.jobId as string;
    const brain = join(fixture.info.dataDir, "brains", bot.id);
    const record = JSON.parse(readFileSync(join(brain, ".edu", "crew", `${jobId}.json`), "utf8"));
    expect(record).toMatchObject({ cli: "codex", autoApprove: false, allowUnregisteredChecks: false, cwd: project });

    const spec = await until(async () => (await gates()).find((row) => !row.card.answered));
    expect(spec.card).toMatchObject({ tool: "edu_crew_gate", options: ["Approve", "Reject"], eduCrewGate: { jobId, gate: "Approve spec", folder: project } });
    expect(existsSync(join(project, "hello.txt"))).toBe(false);
    const shell = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: spec.card.requestId, behavior: "allow" });
    expect(shell.status, JSON.stringify(shell.body)).toBe(403);
    expect(shell.body.error).toMatch(/desktop app or from a paired device/);
    const approved = await owner("POST", `/api/threads/${bot.threadId}/respond`, { requestId: spec.card.requestId, behavior: "allow" });
    expect(approved, JSON.stringify(approved.body)).toMatchObject({ status: 200, body: { ok: true, outcome: "allowed-once" } });

    const step = await until(async () => (await gates()).find((row) => !row.card.answered));
    expect(step.card.eduCrewGate.gate).toBe("Approve builder step");
    expect((await owner("POST", `/api/threads/${bot.threadId}/respond`, { requestId: step.card.requestId, behavior: "allow" })).status).toBe(200);
    await until(async () => ((await lines())[0].eduCrew.status === "done" ? true : undefined));
    expect(readFileSync(join(project, "hello.txt"), "utf8")).toBe("hi\n");
    const details = await owner("GET", `/api/edu/crew/${jobId}`);
    expect(details.body).toMatchObject({ folder: project, line: { status: "done" } });
    expect(details.body.spec).toContain("hello.txt exists");

    script([plan("Something long"), { name: "Bash", input: { command: "sleep 600" }, hold: true }]);
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Another one", "--url", fixture.info.url]);
    const second = await until(async () => (await lines()).find((row) => row.eduCrew.jobId !== jobId));
    await until(async () => (await gates()).find((row) => row.card.eduCrewGate.jobId === second.eduCrew.jobId && !row.card.answered));
    await runControlOmb(["interrupt", "--bot", bot.id, "--task", bot.threadId, "--url", fixture.info.url]);
    await until(async () => ((await lines()).find((row) => row.eduCrew.jobId === second.eduCrew.jobId)?.eduCrew.status === "cancelled" ? true : undefined));
    expect((await gates()).find((row) => row.card.eduCrewGate.jobId === second.eduCrew.jobId)!.card).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(JSON.parse(readFileSync(join(brain, ".edu", "crew", `${second.eduCrew.jobId}.json`), "utf8")).status).toBe("cancelled");
    writeFileSync(release, "");

    const decisions = ((await owner("GET", "/api/decisions")).body.decisions as any[]).filter((row) => row.tool === "edu_crew_gate");
    expect(decisions.map((row) => row.decision).sort()).toEqual(["card-shown", "card-shown", "card-shown", "user-approved", "user-approved"]);

    const review = (input: object) => ({ server: "agents", name: "edu_review", input });
    script([review({ reviewer: "claude" }), review({})]);
    await turn(bot.id, bot.threadId, "Have another vendor review it");
    const reviews = (await lines()).filter((row) => row.eduCrew.kind === "review");
    expect(reviews.map((row) => row.eduCrew), "a Claude bot's review never goes to claude").toEqual([expect.objectContaining({ cli: "codex", status: "done" })]);
    const reviewJob = JSON.parse(readFileSync(join(brain, ".edu", "crew", `${reviews[0]!.eduCrew.jobId}.json`), "utf8"));
    expect(JSON.stringify(reviewJob)).toContain("hello.txt");

    script([review({ question: "HANG_FOREVER", wait_seconds: 0 })]);
    await turn(bot.id, bot.threadId, "One more review");
    const hanging = await until(async () => (await lines()).find((row) => row.eduCrew.title === "HANG_FOREVER"));
    await until(async () => (existsSync(pids) ? true : undefined));
    const { codex, child } = JSON.parse(readFileSync(pids, "utf8")) as { codex: number; child: number };
    const worker = JSON.parse(readFileSync(join(brain, ".edu", "crew", `${hanging.eduCrew.jobId}.json`), "utf8")).pid as number;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect([worker, codex, child].map(alive)).toEqual([true, true, true]);
    closed = true;
    await fixture.close();
    const deadline = Date.now() + 10_000;
    while ([worker, codex, child].some(alive) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 200));
    expect({ worker: alive(worker), codex: alive(codex), child: alive(child) }, "quitting the app ends its crew jobs' process trees").toEqual({ worker: false, codex: false, child: false });
  } finally {
    writeFileSync(release, "");
    if (!closed) await fixture.close();
    await removeTempDir(scratch);
  }
  expect(realBrainTimes()).toBe(before);
}, 300_000);
