// Where an Auto turn works, end to end: a real server and the fake Claude
// CLI, a reachable CUA descriptor for this computer, the fake Local VM
// boundary (group-local-vm-hooks.mjs) with a ready desktop, and the decision
// model pointed at a fake Jev-compatible endpoint on this machine. Today's
// Auto order reaches the Local VM before this computer; a confident answer
// tries the place it names first. Nothing here reaches the real Jev API or
// the person's own desktop.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WORK_PLACE } from "./decider/jobs.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY = "tsk_e2e_work_place_8c2f61a0";

type Script = { status?: number; choice?: string; p?: number };

// Auto may land on the person's own desktop only on macOS and Windows.
const describeAutoHost = process.platform === "linux" ? describe.skip : describe;

describeAutoHost("the decision model picks where an Auto turn works", { timeout: 120_000 }, () => {
  let home = "";
  let data = "";
  let dumpFile = "";
  let finishFile = "";
  let output = "";
  let child: ChildProcess | null = null;
  let jev: Server;
  let base = "";
  let script: Script = {};
  const choiceRequests: Array<{ auth?: string; body: any }> = [];

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 30_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output.slice(-2_000)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const threadState = (botId: string, threadId: string) =>
    api("GET", "/api/bots?messages=0").then(({ body }) =>
      body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId));

  /** One turn on a fresh conversation; returns the computer server the
   * engine was handed. */
  async function turn(botId: string, text: string, pin?: string): Promise<any> {
    const { task } = await apiOk("POST", `/api/bots/${botId}/tasks`, {});
    if (pin) await apiOk("PATCH", `/api/bots/${botId}/tasks/${task.threadId}`, { surface: pin });
    rmSync(dumpFile, { force: true });
    rmSync(finishFile, { force: true });
    await apiOk("POST", `/api/bots/${botId}/messages`, { text, threadId: task.threadId });
    const sent: any = await until((): any => {
      if (!existsSync(dumpFile)) return null;
      try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
    }, Boolean);
    writeFileSync(finishFile, "finish");
    await until(() => threadState(botId, task.threadId), (state) => Boolean(state) && !state.busy);
    return sent.mcpConfig?.mcpServers?.computer;
  }
  // The host mount carries the CUA descriptor's command; the Local VM's does not.
  const onThisComputer = (computer: any) => computer?.env?.OMB_CUA_COMMAND === "/fixture/cua-driver";

  beforeAll(async () => {
    jev = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const send = (status: number, value: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        const question = body.questions?.answer;
        if (req.url !== "/v1/systemone" || body.model !== "jev-latest" || !question) return send(422, { detail: "bad request shape" });
        if (question.type === "noul") return send(200, { answers: { answer: { type: "noul", noul: 0.96 } } });
        // Other jobs that are on by default (quiet notifications when the
        // turn finishes) ask too: they get a failure, so they keep today's
        // behaviour and only this job's requests are counted.
        if (question.instructions !== WORK_PLACE.instructions) return send(503, { detail: "not this test's job" });
        choiceRequests.push({ auth: req.headers.authorization, body });
        if (script.status && script.status !== 200) return send(script.status, { detail: "overloaded" });
        const keys = Object.keys(question.criteria);
        const choice = script.choice!;
        const other = keys.find((key) => key !== choice)!;
        send(200, { answers: { answer: { type: "choice", choice, probabilities: { [choice]: script.p, [other]: Math.round((1 - script.p!) * 100) / 100 } } } });
      });
    });
    await new Promise<void>((resolve) => jev.listen(0, "127.0.0.1", resolve));
    const jevUrl = `http://127.0.0.1:${(jev.address() as AddressInfo).port}`;

    home = mkdtempSync(join(tmpdir(), "omb-decider-place-"));
    data = join(home, "data");
    const ui = join(home, "static");
    const stateFile = join(home, "vm.json");
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    // Every Local VM exists and is ready, so the boot inventory marks it seen.
    writeFileSync(stateFile, JSON.stringify({}));
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Decider work place</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    mkdirSync(join(home, "user-data"), { recursive: true });
    writeFileSync(join(home, "user-data", "cua-connection.json"), JSON.stringify({
      mode: "embedded", status: "ready", socketPath: join(home, "cua.sock"),
      mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
    }), { mode: 0o600 });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: { claude: {
        driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
        environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
      } },
      decider: { enabled: true, baseUrl: jevUrl, jobs: { workPlace: true } },
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    const proc = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui, OMB_TEST_VM_STATE: stateFile,
        OMB_USER_DATA: join(home, "user-data"), OMB_JEV_API_KEY: KEY,
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean);
  }, 60_000);

  afterAll(async () => {
    if (child) {
      writeFileSync(finishFile, "finish");
      await waitForExit(child, { signal: "SIGTERM" });
    }
    await new Promise<void>((resolve) => (jev ? jev.close(() => resolve()) : resolve()));
    if (home) await removeTempDir(home);
  });

  let botId = "";

  it("an unsure answer keeps today's Auto order: the Local VM before this computer", async () => {
    ({ bot: { id: botId } } = await apiOk("POST", "/api/bots", { name: "Place Bot", description: "Handles desktop chores." }));
    script = { choice: "this_computer", p: 0.55 };
    const computer = await turn(botId, "Open Keynote on my Mac and export the deck.");
    expect(computer).toBeTruthy();
    expect(onThisComputer(computer)).toBe(false);
    const request = choiceRequests.at(-1)!;
    expect(request.auth).toBe(`Bearer ${KEY}`);
    expect(request.body.questions.answer.instructions).toBe(WORK_PLACE.instructions);
    expect(Object.keys(request.body.questions.answer.criteria)).toEqual(["local_vm", "this_computer"]);
    expect(request.body.state).toEqual({ message: "Open Keynote on my Mac and export the deck.", bot: "Place Bot: Handles desktop chores." });
  });

  it("a confident answer tries the place it names first", async () => {
    script = { choice: "this_computer", p: 0.9 };
    expect(onThisComputer(await turn(botId, "Open Keynote on my Mac and export the deck."))).toBe(true);
    script = { choice: "local_vm", p: 0.9 };
    expect(onThisComputer(await turn(botId, "Try this installer somewhere safe."))).toBe(false);
  });

  it("a failing decision model keeps today's order", async () => {
    script = { status: 529 };
    expect(onThisComputer(await turn(botId, "Open Keynote on my Mac."))).toBe(false);
  });

  it("a pinned conversation never asks", async () => {
    script = { choice: "this_computer", p: 0.99 };
    const asked = choiceRequests.length;
    expect(onThisComputer(await turn(botId, "Open Keynote on my Mac.", "vm"))).toBe(false);
    expect(choiceRequests.length).toBe(asked);
    expect(output).not.toContain(KEY);
  });
});
