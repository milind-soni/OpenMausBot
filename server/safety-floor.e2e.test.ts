// Real isolated server + native Claude permission broker, with the fake
// engine parked. On a Windows runner the floor is not applied, so the test
// checks that instead and stops there. The "engine" asking for permission is this test, writing a
// fake request to the broker's socket and reading the answer back: no
// command named here is run by anything, and no live data is touched.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

it("denies a never-list command a grant would have allowed, at a saved command and at Full access, and leaves a person's card alone", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir, logPath } = fixture.info;
  const sockets: Socket[] = [];
  let restarted: ChildProcess | undefined;
  let stream: SseRecorder | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const messages = async (thread: string): Promise<any[]> => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages;
  const card = async (thread: string, id: string) => (await messages(thread)).find(message => message.card?.requestId === id)?.card;
  const notices = async (thread: string): Promise<string[]> => (await messages(thread))
    .flatMap(message => message.kind === "activity" && typeof message.tool?.name === "string" && message.tool.name.startsWith("notice: Blocked") ? [message.tool.name] : []);
  const decision = async (id: string) => (await api("GET", "/api/decisions")).decisions.filter((row: any) => row.requestId === id);
  /** Start a turn the fake engine parks, and return its permission socket. */
  const start = async (bot: any) => {
    const dump = join(dataDir, "fake-claude-dump.json");
    rmSync(dump, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hold this verification task while its approvals are exercised." }, 202);
    await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
    return JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.ogb.args.at(-1) as string;
  };
  /** One fake Bash permission request, as the engine's broker client sends it. */
  const ask = async (socketPath: string, command: string) => {
    const socket = connect(socketPath);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const id = randomUUID();
    let answer: any;
    let buffer = "";
    const reply = new Promise<any>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("close", () => reject(new Error(`Permission socket closed before its reply: ${id}`)));
      socket.setTimeout(10_000, () => socket.destroy(new Error(`Permission reply timed out: ${id}`)));
      socket.on("data", chunk => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        answer = JSON.parse(buffer.split("\n")[0]!);
        socket.setTimeout(0);
        resolve(answer);
      });
    });
    void reply.catch(() => {});
    socket.write(JSON.stringify({ t: "ask", id, tool: "Bash", input: { command } }) + "\n");
    return { id, answer: () => answer, reply };
  };
  const stop = (bot: any) => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  /** The fold answered by itself: a deny carrying the reason, one line the
   * person sees, one decision row, and no card. */
  const expectFloored = async (bot: any, request: Awaited<ReturnType<typeof ask>>, label: string, rule: string) => {
    expect(await request.reply).toMatchObject({ id: request.id, behavior: "deny", message: expect.stringContaining(`Blocked by the safety floor: ${label}.`) });
    expect(await card(bot.threadId, request.id)).toBeUndefined();
    await expect.poll(async () => await notices(bot.threadId)).toContain(`notice: Blocked by the safety floor: ${label}`);
    await expect.poll(async () => await decision(request.id)).toEqual([
      expect.objectContaining({ decision: "auto-denied", source: "safety-floor", rule, tool: "Bash", botId: bot.id }),
    ]);
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Safety floor fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "ask" });
    stream = await openSse(`${url}/api/events`);
    const socket = await start(bot);
    const wipe = "rm -rf /";

    // Off by default. A person answers the card and saves the command; the
    // saved command then answers the next request, exactly as before.
    const first = await ask(socket, wipe);
    await expect.poll(async () => Boolean((await card(bot.threadId, first.id))?.commandAllowlist)).toBe(true);
    // The request reaches every connected client without its exact command:
    // neither the grant descriptor nor the line the safety floor reads.
    const broadcast = await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "request.opened" && frame.event.requestId === first.id);
    expect(broadcast.event).toMatchObject({ tool: "Bash", requestType: "permission" });
    expect(broadcast.event).not.toHaveProperty("command");
    expect(broadcast.event).not.toHaveProperty("commandLine");
    expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.id, behavior: "allow", rememberCommand: true })).outcome).toBe("allowed-once");
    expect(await first.reply).toMatchObject({ id: first.id, behavior: "allow" });
    const unguarded = await ask(socket, wipe);
    expect(await unguarded.reply).toMatchObject({ id: unguarded.id, behavior: "allow" });
    await expect.poll(async () => await decision(unguarded.id)).toEqual([expect.objectContaining({ decision: "auto-approved", source: "command-allowlist" })]);
    expect(await notices(bot.threadId)).toEqual([]);

    // Switched on in Settings: it applies to the very next request.
    expect((await api("GET", "/api/config")).safetyFloor).toEqual({ enabled: false });
    await api("PUT", "/api/config", { safetyFloor: { enabled: true } });
    if (process.platform === "win32") {
      // Not applied on a Windows server yet. The setting is saved, the
      // server reports the floor as not in force, and the saved command
      // goes on answering exactly as it did with the setting off.
      expect((await api("GET", "/api/config")).safetyFloor).toEqual({ enabled: false });
      const unapplied = await ask(socket, wipe);
      expect(await unapplied.reply).toMatchObject({ id: unapplied.id, behavior: "allow" });
      expect(await notices(bot.threadId)).toEqual([]);
      await stop(bot);
      return;
    }
    expect((await api("GET", "/api/config")).safetyFloor).toEqual({ enabled: true });
    const guarded = await ask(socket, wipe);
    await expectFloored(bot, guarded, "recursive delete of the filesystem root", "delete-root");
    expect(await notices(bot.threadId)).toHaveLength(1);

    // A card a person answers is not overridden: at Ask an unsaved never-list
    // command still reaches them, and their Allow stands.
    const theirs = await ask(socket, "rm -rf ~");
    await expect.poll(async () => Boolean(await card(bot.threadId, theirs.id))).toBe(true);
    expect(theirs.answer()).toBeUndefined();
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: theirs.id, behavior: "allow" });
    expect(await theirs.reply).toMatchObject({ id: theirs.id, behavior: "allow" });
    expect(await notices(bot.threadId)).toHaveLength(1);
    await stop(bot);

    // Restart with the file's switch removed and only OMB_SAFETY_FLOOR=1 set,
    // then give the bot Full access the way a person does.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const { safetyFloor: _removed, ...saved } = JSON.parse(readFileSync(configPath, "utf8"));
    expect(_removed).toEqual({ enabled: true });
    writeFileSync(configPath, JSON.stringify(saved, null, 2));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...verificationServerEnvironment({ FAKE_CLAUDE_MODE: "hang" }, dataDir, Number(new URL(url).port)), OMB_SAFETY_FLOOR: "1" },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    // the file no longer enables it; the environment alone does
    expect(JSON.parse(readFileSync(configPath, "utf8")).safetyFloor).toBeUndefined();
    expect((await api("GET", "/api/config")).safetyFloor).toEqual({ enabled: true });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "full" });
    const fullSocket = await start(bot);

    // Full access answers every request except one on the never-list.
    const atFull = await ask(fullSocket, "sudo rm -rf /etc");
    await expectFloored(bot, atFull, "recursive delete of /etc", "delete-system-directory");
    const ordinary = await ask(fullSocket, "printf 'safety floor fixture'");
    expect(await ordinary.reply).toMatchObject({ id: ordinary.id, behavior: "allow" });
    expect(await card(bot.threadId, ordinary.id)).toBeUndefined();
    await expect.poll(async () => await decision(ordinary.id)).toEqual([expect.objectContaining({ decision: "auto-approved", source: "full-access" })]);
    // the same words as data are not a command
    const quoted = await ask(fullSocket, "git commit -m 'never run rm -rf /'");
    expect(await quoted.reply).toMatchObject({ id: quoted.id, behavior: "allow" });
    expect(await notices(bot.threadId)).toHaveLength(2);
    await stop(bot);
    console.info(`Safety floor real-server verification passed; isolated log: ${logPath}`);
  } finally {
    stream?.close();
    for (const socket of sockets) socket.destroy();
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
