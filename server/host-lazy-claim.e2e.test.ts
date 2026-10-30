import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { CONTROL_BUSY, CONTROL_HANDED_BACK, CONTROL_REFUSAL_PLAIN, CONTROL_WAITED, controlRefusal, createControlClient } from "./control-client.ts";
import { computerPersonAwayText } from "./computer-wait.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { answerYourComputer, openYourComputerCard, withAnswer } from "./testing/your-computer.ts";
import { YOUR_COMPUTER_WAITING } from "./your-computer-consent.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// A first screen call must clear within ACT_WITHIN_MS, the person's answer to its card and the seat's claim included.
const CALL_WAIT_MS = hostTimeout(5_000);
const ACT_WITHIN_MS = hostTimeout(1_000);

describe("lazy host claim and pin on use (issue #1650)", () => {
  let home = "";
  let data = "";
  let ui = "";
  let stateFile = "";
  let dumpFile = "";
  let finishFile = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";

  // No Local VM anywhere, so an Auto turn falls past attachLocalVm to the host fallback.
  const vmState = () => writeFileAtomic(stateFile, JSON.stringify({ noContainers: true }));
  const resetTurn = () => { vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true }); };
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
    const end = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  // The dump file is rewritten by every dispatch; wait for THIS bot's turn.
  const dumpFor = (botId: string): Promise<any> => until((): any => {
    if (!existsSync(dumpFile)) return null;
    try {
      const sent = JSON.parse(readFileSync(dumpFile, "utf8"));
      return sent.mcpConfig?.mcpServers?.computer?.env?.OMB_CONTROL_URL?.includes(botId) ? sent : null;
    } catch { return null; }
  }, Boolean);
  const mountedComputer = (sent: any) => sent.mcpConfig.mcpServers.computer;
  const gate = (computer: any) =>
    createControlClient({ url: computer.env.OMB_CONTROL_URL, token: computer.env.OMB_CONTROL_TOKEN }).state(true);
  const timed = async <T>(work: Promise<T>) => {
    const started = Date.now();
    const value = await work;
    return { value, ms: Date.now() - started };
  };
  const threadState = (botId: string, threadId: string) =>
    api("GET", "/api/bots?messages=0").then(({ body }) =>
      body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId));
  const busy = (botId: string, threadId: string) => until(() => threadState(botId, threadId), Boolean);
  const idle = (botId: string, threadId: string) => until(() => threadState(botId, threadId), task => !task?.busy);
  const savedTask = (botId: string, threadId: string) =>
    (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[])
      .find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId);

  async function start(env: Record<string, string> = {}) {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    // The desktop app's own server: it hears the app's driver record over its parent port, as Electron hands it over.
    const proc = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
      "--import", pathToFileURL(join(ROOT, "server/testing/desktop-parent.mjs")).href, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui, OMB_TEST_VM_STATE: stateFile,
        OMB_USER_DATA: join(home, "user-data"), OMB_TEST_DESKTOP_CUA_CONNECTION: join(home, "user-data", "cua-connection.json"),
        OMB_COMPUTER_CALL_WAIT_MS: String(CALL_WAIT_MS),
        OMB_COMPUTER_CALL_ACT_WITHIN_MS: String(ACT_WITHIN_MS), ...env,
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean);
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    writeFileSync(finishFile, "finish");
    await waitForExit(proc, { signal: "SIGTERM" });
  }
  // Auto may land on the person's own desktop only on macOS and Windows.
  const itAutoHost = process.platform === "linux" ? it.skip : it;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-host-lazy-claim-"));
    data = join(home, "data");
    ui = join(home, "static");
    stateFile = join(home, "vm.json");
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    vmState();
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Host lazy claim</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    mkdirSync(join(home, "user-data"), { recursive: true });
    writeFileSync(join(home, "user-data", "cua-connection.json"), JSON.stringify({
      mode: "embedded", status: "ready", socketPath: join(home, "cua.sock"),
      mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
    }), { mode: 0o600 });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
    } } }));
  });
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });
  afterEach(async () => { await stop(); resetTurn(); });

  itAutoHost("holds no computer:host claim and records no pin until a screen tool runs", async () => {
    await start();
    const { bot: holder } = await apiOk("POST", "/api/bots", { name: "Screenless Host Bot" });
    const { task } = await apiOk("POST", `/api/bots/${holder.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${holder.id}/messages`, { text: "Work slowly without touching the screen.", threadId: task.threadId });
    await busy(holder.id, task.threadId);
    const computer = mountedComputer(await dumpFor(holder.id));
    expect(computer.env.OMB_CUA_COMMAND).toBe("/fixture/cua-driver");
    expect(computer.args.some((arg: string) => arg.includes("local-computer-proxy"))).toBe(true);
    expect(savedTask(holder.id, task.threadId)).not.toHaveProperty("surface");
    const { bot: claimer } = await apiOk("POST", "/api/bots", { name: "Host Claim Bot" });
    const { task: claimTask } = await apiOk("POST", `/api/bots/${claimer.id}/tasks`, {});
    await apiOk("POST", `/api/bots/${claimer.id}/messages`, { text: "Work slowly too.", threadId: claimTask.threadId });
    await busy(claimer.id, claimTask.threadId);
    expect(await withAnswer(base, claimTask.threadId, gate(mountedComputer(await dumpFor(claimer.id))))).toEqual({ held: false, helpOpen: false });
    await until(() => savedTask(claimer.id, claimTask.threadId)?.surface === "local", Boolean);
    expect(savedTask(holder.id, task.threadId)).not.toHaveProperty("surface");
    writeFileSync(finishFile, "finish");
    await idle(holder.id, task.threadId);
    await idle(claimer.id, claimTask.threadId);
  });

  itAutoHost("claims the seat and records the pin on the first screen tool call", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Host Screen Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work slowly; the screen comes later.", threadId: task.threadId });
    await busy(bot.id, task.threadId);
    const computer = mountedComputer(await dumpFor(bot.id));
    expect(savedTask(bot.id, task.threadId)).not.toHaveProperty("surface");
    expect(await withAnswer(base, task.threadId, gate(computer))).toEqual({ held: false, helpOpen: false });
    await until(() => savedTask(bot.id, task.threadId)?.surface === "local", Boolean);
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "local", surfaceSource: "auto" });
    const { bot: second } = await apiOk("POST", "/api/bots", { name: "Host Contended Bot" });
    const { task: secondTask } = await apiOk("POST", `/api/bots/${second.id}/tasks`, {});
    await apiOk("POST", `/api/bots/${second.id}/messages`, { text: "Also work slowly.", threadId: secondTask.threadId });
    await busy(second.id, secondTask.threadId);
    const contested = await timed(withAnswer(base, secondTask.threadId, gate(mountedComputer(await dumpFor(second.id)))));
    expect(contested.value).toEqual({ held: true, helpOpen: false, blockedReason: CONTROL_BUSY });
    expect(controlRefusal(contested.value)).not.toBe(CONTROL_REFUSAL_PLAIN);
    expect(contested.ms).toBeGreaterThanOrEqual(CALL_WAIT_MS - 200);
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await idle(second.id, secondTask.threadId);
  });

  itAutoHost("a busy computer is waited for inside the call: it answers when the holder ends, and a person's hold is waited out", async () => {
    await start();
    const turn = async (name: string) => {
      const { bot } = await apiOk("POST", "/api/bots", { name });
      const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
      await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work slowly on the screen.", threadId: task.threadId });
      await busy(bot.id, task.threadId);
      return { bot, threadId: task.threadId as string, computer: mountedComputer(await dumpFor(bot.id)) };
    };
    const holder = await turn("Host Holder Bot");
    expect(await withAnswer(base, holder.threadId, gate(holder.computer))).toEqual({ held: false, helpOpen: false });
    const waiter = await turn("Host Waiter Bot");

    const waiting = timed(gate(waiter.computer));
    await answerYourComputer(base, waiter.threadId);
    await until(() => api("GET", `/api/threads/${waiter.threadId}/messages`).then(({ body }) =>
      (body.messages as any[]).some(m => String(m.tool?.name ?? "").startsWith("Waiting for its turn on this computer"))), Boolean);
    await new Promise(resolve => setTimeout(resolve, ACT_WITHIN_MS + 200));
    await apiOk("POST", `/api/bots/${holder.bot.id}/interrupt`, { threadId: holder.threadId });
    const freed = await waiting;
    expect(freed.value).toEqual({ held: true, helpOpen: false, blockedReason: CONTROL_WAITED });
    expect(freed.ms).toBeLessThan(CALL_WAIT_MS);
    const next = await timed(gate(waiter.computer));
    expect(next.value).toEqual({ held: false, helpOpen: false });
    expect(next.ms).toBeLessThan(ACT_WITHIN_MS);
    await until(() => savedTask(waiter.bot.id, waiter.threadId)?.surface === "local", Boolean);

    const control = (action: "take" | "release") => apiOk("POST", `/api/bots/${waiter.bot.id}/computer/control`, { action });
    await control("take");
    const handedBack = timed(gate(waiter.computer));
    await new Promise(resolve => setTimeout(resolve, 500));
    await control("release");
    expect((await handedBack).value).toEqual({ held: true, helpOpen: false, blockedReason: CONTROL_HANDED_BACK });
    expect((await handedBack).ms).toBeLessThan(CALL_WAIT_MS);
    expect(await gate(waiter.computer)).toEqual({ held: false, helpOpen: false });

    await control("take");
    const stillHeld = await timed(gate(waiter.computer));
    expect(stillHeld.value).toEqual({ held: true, helpOpen: false, reason: "person" });
    expect(controlRefusal(stillHeld.value)).toBe(CONTROL_REFUSAL_PLAIN);
    expect(stillHeld.ms).toBeGreaterThanOrEqual(CALL_WAIT_MS - 200);

    const cancelled = timed(gate(waiter.computer));
    await new Promise(resolve => setTimeout(resolve, 300));
    await apiOk("POST", `/api/bots/${waiter.bot.id}/interrupt`, { threadId: waiter.threadId });
    expect((await cancelled).value.held).toBe(true);
    expect((await cancelled).ms).toBeLessThan(CALL_WAIT_MS - 500);
    await control("release");
    await idle(holder.bot.id, holder.threadId);
    await idle(waiter.bot.id, waiter.threadId);
  }, 60_000);

  itAutoHost("a person's hold past the wait ceiling is not waited for: the turn is told to stop and say so", async () => {
    const ceilingMs = 2_000;
    await start({ OMB_COMPUTER_WAIT_MAX_MS: String(ceilingMs) });
    const { bot } = await apiOk("POST", "/api/bots", { name: "Host Away Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work slowly on the screen.", threadId: task.threadId });
    await busy(bot.id, task.threadId);
    const computer = mountedComputer(await dumpFor(bot.id));
    expect(await withAnswer(base, task.threadId, gate(computer))).toEqual({ held: false, helpOpen: false });
    const control = (action: "take" | "release") => apiOk("POST", `/api/bots/${bot.id}/computer/control`, { action });
    await control("take");
    const tookAt = Date.now();
    const away = { held: true, helpOpen: false, blockedReason: computerPersonAwayText(ceilingMs) };
    const first = await timed(gate(computer));
    expect(first.value).toEqual(away);
    expect(Date.now() - tookAt).toBeGreaterThanOrEqual(ceilingMs - 200);
    expect(first.ms).toBeLessThan(CALL_WAIT_MS);
    const again = await timed(gate(computer));
    expect(again.value).toEqual(away);
    expect(again.ms).toBeLessThan(500);
    expect(controlRefusal(again.value)).toContain("tell the person you are waiting for them to hand control back");
    await control("release");
    expect(await gate(computer)).toEqual({ held: false, helpOpen: false });
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
  }, 60_000);

  itAutoHost("a call waiting behind another turn never goes through once its own turn is stopped", async () => {
    await start();
    const turn = async (name: string) => {
      const { bot } = await apiOk("POST", "/api/bots", { name });
      const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
      await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work slowly on the screen.", threadId: task.threadId });
      await busy(bot.id, task.threadId);
      return { bot, threadId: task.threadId as string, computer: mountedComputer(await dumpFor(bot.id)) };
    };
    const holder = await turn("Host Keeper Bot");
    expect(await withAnswer(base, holder.threadId, gate(holder.computer))).toEqual({ held: false, helpOpen: false });
    const waiter = await turn("Host Quitter Bot");
    const waiting = timed(gate(waiter.computer));
    await answerYourComputer(base, waiter.threadId);
    await until(() => api("GET", `/api/threads/${waiter.threadId}/messages`).then(({ body }) =>
      (body.messages as any[]).some(m => String(m.tool?.name ?? "").startsWith("Waiting for its turn on this computer"))), Boolean);
    await apiOk("POST", `/api/bots/${waiter.bot.id}/interrupt`, { threadId: waiter.threadId });
    const stopped = await waiting;
    expect(stopped.value.held).toBe(true);
    expect(controlRefusal(stopped.value)).not.toBe(CONTROL_REFUSAL_PLAIN);
    expect(stopped.ms).toBeLessThan(CALL_WAIT_MS);
    writeFileSync(finishFile, "finish");
    await idle(holder.bot.id, holder.threadId);
    await idle(waiter.bot.id, waiter.threadId);
  }, 60_000);

  itAutoHost("asks once before the first screen call even at Just do it, in plain words naming the app and the site", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Host Asking Bot" });
    // The default approval level is "Just do it": nothing else in this turn asks.
    expect(bot.approvalMode ?? "full").toBe("full");
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Look at my calendar slowly.", threadId: task.threadId });
    await busy(bot.id, task.threadId);
    const computer = mountedComputer(await dumpFor(bot.id));
    const client = createControlClient({ url: computer.env.OMB_CONTROL_URL, token: computer.env.OMB_CONTROL_TOKEN });
    // Exactly what the mounted proxy sends for launch_app { bundle_id: "com.google.Chrome", urls: [...] }.
    const first = timed(client.state(true, { app: "Chrome", site: "calendar.google.com" }));
    const card = await openYourComputerCard(base, task.threadId);
    expect(card.title).toBe("I need to use your Chrome where you're signed in to calendar.google.com. Allow once?");
    expect(card.subtitle).toBe("Host Asking Bot would see your screen and click and type on it, for this request only.");
    expect((await threadState(bot.id, task.threadId))?.activity).toBe("waiting-on-you");
    // Unanswered, the call is not performed and says why, then waits again.
    const unanswered = await first;
    expect(unanswered.value).toEqual({ held: true, helpOpen: false, blockedReason: YOUR_COMPUTER_WAITING });
    expect(unanswered.ms).toBeGreaterThanOrEqual(CALL_WAIT_MS - 200);
    expect(savedTask(bot.id, task.threadId)).not.toHaveProperty("surface");
    expect(await withAnswer(base, task.threadId, client.state(true))).toEqual({ held: false, helpOpen: false });
    // One answer covers the request: later calls go straight through, with no second card.
    expect(await client.state(true)).toEqual({ held: false, helpOpen: false });
    const cards = (await apiOk("GET", `/api/threads/${task.threadId}/messages?limit=200`)).messages
      .filter((message: any) => message.card?.tool === "use_your_computer");
    expect(cards.map((message: any) => message.card.answered)).toEqual(["allow"]);
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
  }, 60_000);

  itAutoHost("a No is an answer, not a failure: the screen stays untouched and the bot is told to finish another way", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Host Declined Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Book a table slowly.", threadId: task.threadId });
    await busy(bot.id, task.threadId);
    const computer = mountedComputer(await dumpFor(bot.id));
    const declined = await withAnswer(base, task.threadId, gate(computer), "deny");
    expect(declined.held).toBe(true);
    expect(declined.blockedReason).toContain("the person said no to using their own computer");
    expect(declined.blockedReason).toContain("use your own browser, a cloud computer or a connected app");
    expect(await gate(computer)).toEqual(declined);
    // The turn goes on; no failed-turn row, and nothing claimed or pinned.
    expect((await threadState(bot.id, task.threadId))?.busy).toBe(true);
    const messages = (await apiOk("GET", `/api/threads/${task.threadId}/messages?limit=200`)).messages as any[];
    expect(messages.some((message) => String(message.tool?.name ?? "").includes("could not be claimed"))).toBe(false);
    expect(savedTask(bot.id, task.threadId)).not.toHaveProperty("surface");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
  }, 60_000);

  itAutoHost("a question the request outlives is closed, and answers nothing", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Host Stopped Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work slowly on the screen.", threadId: task.threadId });
    await busy(bot.id, task.threadId);
    const pending = gate(mountedComputer(await dumpFor(bot.id)));
    const card = await openYourComputerCard(base, task.threadId);
    await apiOk("POST", `/api/bots/${bot.id}/interrupt`, { threadId: task.threadId });
    expect((await pending).held).toBe(true);
    await idle(bot.id, task.threadId);
    const closed = (await apiOk("GET", `/api/threads/${task.threadId}/messages?limit=200`)).messages
      .find((message: any) => message.card?.requestId === card.requestId)?.card;
    expect(closed).toMatchObject({ answered: "deny", dismissed: true });
  }, 60_000);

  itAutoHost("asks again on the next request, and never when the person picked this computer themselves", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Host Again Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    const request = async (text: string) => {
      resetTurn();
      await apiOk("POST", `/api/bots/${bot.id}/messages`, { text, threadId: task.threadId });
      await busy(bot.id, task.threadId);
      return mountedComputer(await dumpFor(bot.id));
    };
    const cards = async () => ((await apiOk("GET", `/api/threads/${task.threadId}/messages?limit=200`)).messages as any[])
      .filter((message) => message.card?.tool === "use_your_computer").length;
    expect(await withAnswer(base, task.threadId, gate(await request("Open my calendar slowly.")))).toEqual({ held: false, helpOpen: false });
    await until(() => savedTask(bot.id, task.threadId)?.surfaceSource === "auto", Boolean);
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    // An Auto pin is the bot's choice, not the person's: the next request on it asks once more.
    expect(await withAnswer(base, task.threadId, gate(await request("Now add lunch on Friday, slowly.")))).toEqual({ held: false, helpOpen: false });
    expect(await cards()).toBe(2);
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    expect(await gate(await request("Carry on, slowly."))).toEqual({ held: false, helpOpen: false });
    expect(await cards()).toBe(2);
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
  }, 60_000);
});
