import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const fakeCli = join(serverDirectory, "testing", "fake-acp-cli.ts");
const port = 38_000 + Math.floor(Math.random() * 10_000);
const base = `http://127.0.0.1:${port}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("room activity runtime", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let streamAbort: AbortController;
  const frames: any[] = [];
  const listeners = new Set<(frame: any) => void>();

  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  const waitForFrame = (predicate: (frame: any) => boolean, label: string, timeoutMs = 12_000, after = 0) => {
    const existing = frames.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        listeners.delete(onFrame);
        reject(new Error(`timed out waiting for ${label}. stderr:\n${stderr.slice(-2_000)}`));
      }, timeoutMs);
      const onFrame = (frame: any) => {
        if (!predicate(frame)) return;
        clearTimeout(timeout);
        listeners.delete(onFrame);
        resolve(frame);
      };
      listeners.add(onFrame);
    });
  };

  beforeAll(async () => {
    chmodSync(fakeCli, 0o755);
    for (const cli of ["fake-claude-cli.ts", "fake-codex-app-server.ts"]) chmodSync(join(serverDirectory, "testing", cli), 0o755);
    home = mkdtempSync(join(tmpdir(), "gbs-room-activity-"));
    const dataDirectory = join(home, ".gbs");
    mkdirSync(dataDirectory);
    writeFileSync(join(dataDirectory, "config.json"), JSON.stringify({
      instances: {
        "steer-claude": { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "steer" }, config: { cli: join(serverDirectory, "testing", "fake-claude-cli.ts") } },
        "steer-codex": { driver: "codex", environment: { FAKE_CODEX_MODE: "steer" }, config: { cli: join(serverDirectory, "testing", "fake-codex-app-server.ts") } },
        "reject-codex": { driver: "codex", environment: { FAKE_CODEX_MODE: "steer-reject" }, config: { cli: join(serverDirectory, "testing", "fake-codex-app-server.ts") } },
        "steer-usage": { driver: "codex", environment: { FAKE_CODEX_MODE: "steer-usage" }, config: { cli: join(serverDirectory, "testing", "fake-codex-app-server.ts") } },
        "reject-hang": { driver: "codex", environment: { FAKE_CODEX_MODE: "steer-reject-hang" }, config: { cli: join(serverDirectory, "testing", "fake-codex-app-server.ts") } },
        permission: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "permission" },
          config: { cli: fakeCli, fullAuto: false },
        },
        mentions: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "mention-beta" },
          config: { cli: fakeCli, fullAuto: false },
        },
        happy: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "happy" },
          config: { cli: fakeCli, fullAuto: false },
        },
        "mentions-gamma": {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "mention-beta", FAKE_ACP_MENTION: "Gamma" },
          config: { cli: fakeCli, fullAuto: false },
        },
        "mentions-alpha": {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "mention-beta", FAKE_ACP_MENTION: "Alpha" },
          config: { cli: fakeCli, fullAuto: false },
        },
        "mentions-slow": {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "mention-beta", FAKE_ACP_DELAY_MS: "1500" },
          config: { cli: fakeCli, fullAuto: false },
        },
        slow: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "slow", FAKE_ACP_TICKS: "6", FAKE_ACP_TICK_MS: "400" },
          config: { cli: fakeCli, fullAuto: false },
        },
        hang: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "hang" },
          config: { cli: fakeCli, fullAuto: false },
        },
      },
    }));
    child = spawn(process.execPath, [join(serverDirectory, "index.ts")], {
      cwd: join(serverDirectory, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        GBS_PORT: String(port),
        // short idle window so the watchdog tests run fast; the slow fake
        // streams for ~2.4 s, well past it, but never goes quiet
        GBS_GROUP_TURN_IDLE_MS: "1500",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        // Server is still starting.
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    streamAbort = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: streamAbort.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            if (!data) continue;
            const frame = JSON.parse(data);
            frames.push(frame);
            for (const listener of [...listeners]) listener(frame);
          }
        }
      } catch (error) {
        if (!streamAbort.signal.aborted) stderr += `\nSSE reader: ${String(error)}`;
      }
    })();
    await waitForFrame((frame) => frame.kind === "hello", "SSE hello");
  }, 30_000);

  afterAll(async () => {
    streamAbort?.abort();
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("attributes room events, exposes queued responders, and cancels the queue", async () => {
    const selection = { instanceId: "permission", model: "fake-model" };
    const alpha = (await api("POST", "/api/bots")).body.bot;
    const beta = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${alpha.id}`, { name: "Alpha", modelSelection: selection });
    await api("PATCH", `/api/bots/${beta.id}`, { name: "Beta", modelSelection: selection });
    const group = (await api("POST", "/api/groups", { name: "Work room", memberIds: [alpha.id, beta.id] })).body.group;

    expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "@Alpha and @Beta check status" })).status).toBe(202);
    const queued = await waitForFrame(
      (frame) => frame.kind === "group" && frame.group.id === group.id && frame.group.queuedBotIds?.includes(beta.id),
      "Beta in the room queue",
    );
    expect(queued.group.queuedBotIds).toContain(beta.id);

    const started = await waitForFrame(
      (frame) => frame.kind === "runtime" && frame.event.type === "turn.started" && frame.event.threadId === group.threadId,
      "attributed room turn",
    );
    expect(started.botId).toBe(alpha.id);
    const approval = await waitForFrame(
      (frame) => frame.kind === "runtime" && frame.event.type === "request.opened" && frame.event.threadId === group.threadId,
      "attributed approval request",
    );
    expect(approval.botId).toBe(alpha.id);

    expect((await api("POST", `/api/groups/${group.id}/activities/${beta.id}/stop`)).status).toBe(200);
    const betaRemoved = await waitForFrame(
      (frame) => frame.kind === "group" && frame.group.id === group.id && !frame.group.queuedBotIds?.includes(beta.id),
      "Beta removed from the room queue",
    );
    expect(betaRemoved.group.queuedBotIds).not.toContain(beta.id);

    const prompt = await waitForFrame(
      (frame) => frame.kind === "message" && frame.threadId === group.threadId && frame.message.kind === "options",
      "room approval card",
    );
    expect(prompt.message.from.botId).toBe(alpha.id);
    expect(prompt.message.card.options).toEqual(["Allow", "Deny"]);
    expect(prompt.message.card.requestType).toBe("permission");

    const settings = await api("GET", "/api/config");
    expect(settings.body).toMatchObject({ autoApprovePermissions: true, autoApproveDelaySeconds: 10 });

    const response = await api("POST", `/api/bots/${alpha.id}/respond`, {
      requestId: approval.event.requestId,
      behavior: "allow",
      threadId: group.threadId,
      autoApproved: true,
    });
    expect(response.status).toBe(200);
    const resolved = await waitForFrame(
      (frame) => frame.kind === "runtime" && frame.event.type === "request.resolved" && frame.event.requestId === approval.event.requestId,
      "resolved room approval",
    );
    expect(resolved.event.source).toBe("auto");
    const settledCard = await waitForFrame(
      (frame) => frame.kind === "message.patch" && frame.message.id === prompt.message.id,
      "auto-approved card",
    );
    expect(settledCard.message.card).toMatchObject({ answered: "Allow", autoApproved: true, dismissed: false });
    await waitForFrame(
      (frame) => frame.kind === "message" && frame.message.kind === "activity" && frame.message.tool?.name === "Permission auto-approved",
      "room auto-approval activity",
    );

    await waitForFrame(
      (frame) => frame.kind === "runtime" && frame.event.type === "turn.completed" && frame.event.threadId === group.threadId,
      "completed first room turn",
    );

    const secondStart = frames.length;
    expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "@Alpha run another check" })).status).toBe(202);
    const secondApproval = await waitForFrame(
      (frame) => frame.kind === "runtime" && frame.event.type === "request.opened" && frame.event.threadId === group.threadId,
      "second room approval request",
      12_000,
      secondStart,
    );
    expect((await api("PUT", "/api/config", { autoApprovePermissions: false, autoApproveDelaySeconds: 5 })).body)
      .toMatchObject({ autoApprovePermissions: false, autoApproveDelaySeconds: 5 });
    expect((await api("POST", `/api/bots/${alpha.id}/respond`, {
      requestId: secondApproval.event.requestId,
      behavior: "allow",
      threadId: group.threadId,
      autoApproved: true,
    })).status).toBe(409);
    expect((await api("POST", `/api/groups/${group.id}/activities/${alpha.id}/stop`)).status).toBe(200);
    const stopped = await waitForFrame(
      (frame) => frame.kind === "runtime" && frame.event.type === "turn.completed" && frame.event.threadId === group.threadId,
      "stopped room turn",
      12_000,
      secondStart,
    );
    expect(stopped.event.stopReason).toBe("cancelled");

    await api("POST", `/api/groups/${group.id}/interrupt`);
    const cleared = await waitForFrame(
      (frame) => frame.kind === "group" && frame.group.id === group.id && frame.group.queuedBotIds?.length === 0,
      "cleared responder queue",
    );
    expect(cleared.group.queuedBotIds).toEqual([]);
  }, 20_000);

  it("runs Markdown-formatted agent handoffs when global autoHandoffs setting is enabled", async () => {
    const alpha = (await api("POST", "/api/bots")).body.bot;
    const beta = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${alpha.id}`, { name: "Alpha", modelSelection: { instanceId: "mentions", model: "fake-model" } });
    await api("PATCH", `/api/bots/${beta.id}`, { name: "Beta", modelSelection: { instanceId: "happy", model: "fake-model" } });
    const group = (await api("POST", "/api/groups", { name: "Automatic room", memberIds: [alpha.id, beta.id] })).body.group;
    await api("PUT", "/api/config", { autoHandoffs: true });

    const start = frames.length;
    expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "@Alpha begin" })).status).toBe(202);
    const betaTurn = await waitForFrame(
      (frame) => frame.kind === "runtime" && frame.botId === beta.id && frame.event.type === "turn.started",
      "automatic Beta handoff",
      12_000,
      start,
    );
    expect(betaTurn.event.threadId).toBe(group.threadId);
    await waitForFrame(
      (frame) => frame.kind === "runtime" && frame.botId === beta.id && frame.event.type === "turn.completed",
      "bounded Beta completion",
      12_000,
      start,
    );
  }, 20_000);

  it("lets an active room turn run past the idle window and stops one that goes quiet", async () => {
    const worker = (await api("POST", "/api/bots")).body.bot;
    const sleeper = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${worker.id}`, { name: "Worker", modelSelection: { instanceId: "slow", model: "fake-model" } });
    await api("PATCH", `/api/bots/${sleeper.id}`, { name: "Sleeper", modelSelection: { instanceId: "hang", model: "fake-model" } });
    const group = (await api("POST", "/api/groups", { name: "Long room", memberIds: [worker.id, sleeper.id] })).body.group;
    const timeoutLine = (frame: any) =>
      frame.kind === "message" && frame.threadId === group.threadId && /^error: activity/.test(frame.message.tool?.name ?? "");

    const start = frames.length;
    expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "@Worker build it" })).status).toBe(202);
    const done = await waitForFrame(
      (frame) => frame.kind === "runtime" && frame.botId === worker.id && frame.event.type === "turn.completed",
      "long active turn completes",
      12_000,
      start,
    );
    expect(done.event.ok).toBe(true);
    expect(frames.slice(start).some(timeoutLine)).toBe(false);

    const hangStart = frames.length;
    expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "@Sleeper build it" })).status).toBe(202);
    const stopped = await waitForFrame(timeoutLine, "quiet turn stopped", 15_000, hangStart);
    expect(stopped.message.tool.name).toBe("error: activity went quiet for 1 min and was stopped");
    expect(stopped.message.from.botId).toBe(sleeper.id);
  }, 30_000);

  const makeBot = async (name: string, instanceId: string) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model: instanceId === "steer-claude" ? "sonnet" : instanceId.includes("codex") || instanceId === "reject-hang" || instanceId === "steer-usage" ? "gpt-new" : "fake-model" } });
    return bot;
  };
  const turnFrame = (botId: string, type: string) => (frame: any) =>
    frame.kind === "runtime" && frame.botId === botId && frame.event.type === type;

  it("lets a room override the app-wide handoff setting in both directions", async () => {
    const alpha = await makeBot("Alpha", "mentions");
    const beta = await makeBot("Beta", "happy");
    const group = (await api("POST", "/api/groups", { name: "Override room", memberIds: [alpha.id, beta.id] })).body.group;

    // app on, room off: Alpha's @Beta must not chain. A second Alpha turn
    // runs on the same serial queue, so a chained Beta would land before it.
    await api("PUT", "/api/config", { autoHandoffs: true });
    expect((await api("PATCH", `/api/groups/${group.id}`, { handoffs: "off" })).body.group.handoffs).toBe("off");
    const offStart = frames.length;
    await api("POST", `/api/groups/${group.id}/messages`, { text: "@Alpha begin" });
    await api("POST", `/api/groups/${group.id}/messages`, { text: "@Alpha again" });
    let alphaTurns = 0;
    await waitForFrame((frame) => turnFrame(alpha.id, "turn.completed")(frame) && ++alphaTurns === 2, "two Alpha turns", 12_000, offStart);
    expect(frames.slice(offStart).some(turnFrame(beta.id, "turn.started"))).toBe(false);
    // the dropped mention is announced, not silent
    expect(frames.slice(offStart).some((f) => f.kind === "message" && f.threadId === group.threadId
      && f.message.tool?.name === "Auto handoffs are off. Mention Beta to continue.")).toBe(true);

    // app off, room on: the handoff runs
    await api("PUT", "/api/config", { autoHandoffs: false });
    await api("PATCH", `/api/groups/${group.id}`, { handoffs: "on" });
    const onStart = frames.length;
    await api("POST", `/api/groups/${group.id}/messages`, { text: "@Alpha begin" });
    await waitForFrame(turnFrame(beta.id, "turn.completed"), "room-enabled Beta handoff", 12_000, onStart);
    await api("PUT", "/api/config", { autoHandoffs: true });
  }, 30_000);

  it("chains handoffs up to the room's depth", async () => {
    const alpha = await makeBot("Alpha", "mentions");
    const beta = await makeBot("Beta", "mentions-gamma");
    const gamma = await makeBot("Gamma", "happy");
    const group = (await api("POST", "/api/groups", { name: "Chain room", memberIds: [alpha.id, beta.id, gamma.id] })).body.group;
    await api("PATCH", `/api/groups/${group.id}`, { handoffs: "on", maxHops: 2 });

    const start = frames.length;
    await api("POST", `/api/groups/${group.id}/messages`, { text: "@Alpha begin" });
    await waitForFrame(turnFrame(gamma.id, "turn.completed"), "second-hop Gamma turn", 15_000, start);
  }, 30_000);

  it("lets bots hand work back and forth until the room's cap, then says so", async () => {
    const alpha = await makeBot("Alpha", "mentions");
    const beta = await makeBot("Beta", "mentions-alpha");
    const group = (await api("POST", "/api/groups", { name: "Ping-pong room", memberIds: [alpha.id, beta.id] })).body.group;
    await api("PATCH", `/api/groups/${group.id}`, { handoffs: "on", maxHops: 5 });

    const start = frames.length;
    await api("POST", `/api/groups/${group.id}/messages`, { text: "@Alpha begin" });
    const paused = (f: any) => f.kind === "message" && f.threadId === group.threadId && /^Paused after 5 handoffs\. Mention Alpha to continue\.$/.test(f.message.tool?.name ?? "");
    await waitForFrame(paused, "pause notice", 30_000, start);
    const turns = (id: string) => frames.slice(start).filter(turnFrame(id, "turn.completed")).length;
    // user → Alpha, then five handoffs: Beta, Alpha, Beta, Alpha, Beta
    expect(turns(alpha.id)).toBe(3);
    expect(turns(beta.id)).toBe(3);
  }, 40_000);

  it.each(["@Alpha begin", "@Alpha and @Beta begin"])("lets a user message cut in ahead of pending replies to %s", async (opening) => {
    const alpha = await makeBot("Alpha", "mentions-slow");
    const beta = await makeBot("Beta", "happy");
    const gamma = await makeBot("Gamma", "happy");
    const group = (await api("POST", "/api/groups", { name: "Cut-in room", memberIds: [alpha.id, beta.id, gamma.id] })).body.group;
    await api("PATCH", `/api/groups/${group.id}`, { handoffs: "on" });

    const start = frames.length;
    await api("POST", `/api/groups/${group.id}/messages`, { text: opening });
    await waitForFrame(turnFrame(alpha.id, "turn.started"), "Alpha running", 12_000, start);
    // posted while Alpha works; Alpha's reply will @Beta
    expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "@Gamma actually, you take it", steer: true })).status).toBe(202);
    await waitForFrame(turnFrame(gamma.id, "turn.completed"), "Gamma answers the cut-in", 12_000, start);

    const after = frames.slice(start);
    const gammaAt = after.findIndex(turnFrame(gamma.id, "turn.started"));
    const betaAt = after.findIndex(turnFrame(beta.id, "turn.started"));
    expect(gammaAt).toBeGreaterThan(-1);
    expect(betaAt).toBe(-1);
    expect(after.some((f) => f.kind === "message" && f.threadId === group.threadId
      && f.message.tool?.name === "Your message goes first; Beta wasn't called in.")).toBe(true);
  }, 30_000);


  it.each(["steer-claude", "steer-codex"])("steers a running %s in a DM and a room, preserving text order", async instanceId => {
    for (const room of [false, true]) {
      const bot = await makeBot("Pilot", instanceId);
      const group = room ? (await api("POST", "/api/groups", { name: "Steer room", memberIds: [bot.id] })).body.group : undefined;
      const threadId = group?.threadId ?? bot.threadId;
      const route = group ? `/api/groups/${group.id}/messages` : `/api/bots/${bot.id}/messages`;
      const start = frames.length;
      await api("POST", route, { text: "begin steering" });
      await waitForFrame(f => f.kind === "runtime" && f.event.threadId === threadId && f.event.type === "content.delta", "partial text", 12_000, start);
      expect((await api("POST", route, { text: "redirect-now", steer: true, attachments: [{ id: "note", name: "note.txt", mimeType: "text/plain", size: 9, dataUrl: "data:text/plain;base64," + Buffer.from("reference").toString("base64") }] })).status).toBe(202);
      await waitForFrame(f => f.kind === "message.patch" && f.threadId === threadId && f.message.steered === "native", "native delivery", 12_000, start);
      await waitForFrame(turnFrame(bot.id, "turn.completed"), "steered turn completes", 12_000, start);
      const messages = frames.slice(start).filter(f => f.kind === "message" && f.threadId === threadId).map(f => f.message);
      expect(messages.filter(m => m.role === "user" && m.text === "redirect-now")).toHaveLength(1);
      const saved = messages.find(m => m.role === "user" && m.text === "redirect-now").attachments[0];
      expect(await (await fetch(base + saved.url)).text()).toBe("reference");
      const before = messages.findIndex(m => m.text === "Before correction. ");
      const correction = messages.findIndex(m => m.text === "redirect-now");
      expect(before).toBeGreaterThan(-1);
      expect(before).toBeLessThan(correction);
      const tail = messages.slice(correction + 1).filter(m => m.role === "bot" && m.kind === "text").map(m => m.text).join("");
      expect(tail).toContain("redirect-now");
      expect(tail).toContain("note.txt");
      expect(tail).not.toContain("Before correction.");
      expect(frames.slice(start).filter(turnFrame(bot.id, "turn.started"))).toHaveLength(1);
    }
  }, 40_000);

  it("preserves a delivered correction when usage recovery switches to backup", async () => {
    for (const room of [false, true]) {
      const bot = await makeBot("Pilot", "steer-usage");
      await api("PATCH", `/api/bots/${bot.id}`, { backupModelSelection: { instanceId: "happy", model: "fake-model" }, onUsageLimit: "backup" });
      const group = room ? (await api("POST", "/api/groups", { name: "Recovery room", memberIds: [bot.id] })).body.group : undefined;
      const threadId = group?.threadId ?? bot.threadId;
      const route = group ? `/api/groups/${group.id}/messages` : `/api/bots/${bot.id}/messages`;
      const start = frames.length;
      await api("POST", route, { text: "begin" });
      await waitForFrame(f => f.kind === "runtime" && f.event.threadId === threadId && f.event.type === "content.delta", "working", 12_000, start);
      await api("POST", route, { text: "redirect-now", steer: true });
      await waitForFrame(f => f.kind === "message.patch" && f.threadId === threadId && f.message.steered === "native", "delivered", 12_000, start);
      await waitForFrame(f => f.kind === "runtime" && f.event.threadId === threadId && f.event.providerInstanceId === "happy" && f.event.type === "turn.completed", "backup completed", 12_000, start);
      expect(frames.slice(start).filter(f => f.kind === "message" && f.threadId === threadId && f.message.text === "redirect-now")).toHaveLength(1);
      expect(frames.slice(start).filter(turnFrame(bot.id, "turn.started"))).toHaveLength(2);
    }
  }, 30_000);

  it("accepts successive corrections in one native turn", async () => {
    const bot = await makeBot("Pilot", "steer-codex");
    const start = frames.length;
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "begin" });
    await waitForFrame(f => f.kind === "runtime" && f.event.threadId === bot.threadId && f.event.type === "content.delta", "working", 12_000, start);
    for (const text of ["hold-for-more", "redirect-now"]) {
      await api("POST", `/api/bots/${bot.id}/messages`, { text, steer: true });
      await waitForFrame(f => f.kind === "message.patch" && f.threadId === bot.threadId && f.message.text === text && f.message.steered === "native", "native delivery", 12_000, start);
    }
    await waitForFrame(turnFrame(bot.id, "turn.completed"), "done", 12_000, start);
    expect(frames.slice(start).filter(turnFrame(bot.id, "turn.started"))).toHaveLength(1);
  });

  it.each([false, true])("stops and redirects an unsupported provider (room=%s)", async room => {
    const bot = await makeBot("Pilot", "slow");
    const group = room ? (await api("POST", "/api/groups", { name: "Fallback room", memberIds: [bot.id] })).body.group : undefined;
    const threadId = group?.threadId ?? bot.threadId;
    const route = group ? `/api/groups/${group.id}/messages` : `/api/bots/${bot.id}/messages`;
    const start = frames.length;
    await api("POST", route, { text: "begin" });
    await waitForFrame(f => f.kind === "runtime" && f.event.threadId === threadId && f.event.type === "content.delta", "working", 12_000, start);
    await api("POST", route, { text: "redirect-now", steer: true });
    await waitForFrame(f => f.kind === "message.patch" && f.threadId === threadId && f.message.steered === "restarted", "restart", 12_000, start);
    await waitForFrame(f => f.kind === "runtime" && f.event.threadId === threadId && f.event.type === "turn.completed" && frames.slice(start).filter(turnFrame(bot.id, "turn.completed")).length === 2, "redirect completed", 12_000, start);
    expect(frames.slice(start).filter(f => f.kind === "message" && f.threadId === threadId && f.message.text === "redirect-now")).toHaveLength(1);
    expect(frames.slice(start).filter(turnFrame(bot.id, "turn.started"))).toHaveLength(2);
  }, 30_000);

  it("queues rejected native input once and respects Stop while delivery waits", async () => {
    for (const stop of [false, true]) {
      const bot = await makeBot("Pilot", stop ? "reject-hang" : "reject-codex");
      const route = `/api/bots/${bot.id}/messages`;
      const start = frames.length;
      await api("POST", route, { text: "begin" });
      await waitForFrame(f => f.kind === "runtime" && f.event.threadId === bot.threadId && f.event.type === "content.delta", "working", 12_000, start);
      await api("POST", route, { text: "redirect-now", steer: true });
      if (stop) await api("POST", `/api/bots/${bot.id}/interrupt`);
      await waitForFrame(f => f.kind === "message.patch" && f.threadId === bot.threadId && f.message.steered === (stop ? "cancelled" : "queued"), "delivery result", 12_000, start);
      expect(frames.slice(start).filter(turnFrame(bot.id, "turn.started"))).toHaveLength(stop ? 1 : 2);
      expect(frames.slice(start).filter(f => f.kind === "message" && f.threadId === bot.threadId && f.message.text === "redirect-now")).toHaveLength(1);
    }
  }, 30_000);

  it("treats steering after a completed turn as an ordinary new request", async () => {
    const bot = await makeBot("Pilot", "happy");
    const start = frames.length;
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "begin" });
    await waitForFrame(turnFrame(bot.id, "turn.completed"), "done", 12_000, start);
    const next = frames.length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "late correction", steer: true })).status).toBe(202);
    await waitForFrame(turnFrame(bot.id, "turn.completed"), "next done", 12_000, next);
  });

  it("routes unmentioned messages to the room's default responder", async () => {
    const alpha = await makeBot("Alpha", "happy");
    const beta = await makeBot("Beta", "happy");
    const group = (await api("POST", "/api/groups", { name: "Default room", memberIds: [alpha.id, beta.id] })).body.group;
    await api("PATCH", `/api/groups/${group.id}`, { defaultResponderId: beta.id });

    const start = frames.length;
    await api("POST", `/api/groups/${group.id}/messages`, { text: "anyone there?" });
    await waitForFrame(turnFrame(beta.id, "turn.completed"), "default responder turn", 12_000, start);
    expect(frames.slice(start).some(turnFrame(alpha.id, "turn.started"))).toBe(false);
  }, 20_000);

  it("stops a removed member's turn, clears its default role and announces roster changes", async () => {
    const lead = await makeBot("Lead", "happy");
    const sleeper = await makeBot("Sleeper", "hang");
    const extra = await makeBot("Extra", "happy");
    const group = (await api("POST", "/api/groups", { name: "Roster room", memberIds: [lead.id, sleeper.id] })).body.group;
    await api("PATCH", `/api/groups/${group.id}`, { defaultResponderId: sleeper.id });

    const start = frames.length;
    await api("POST", `/api/groups/${group.id}/messages`, { text: "@Sleeper go" });
    await waitForFrame(turnFrame(sleeper.id, "turn.started"), "Sleeper running", 12_000, start);

    const patched = await api("PATCH", `/api/groups/${group.id}`, { memberIds: [lead.id, extra.id] });
    expect(patched.status).toBe(200);
    expect(patched.body.group).toMatchObject({ memberIds: [lead.id, extra.id], defaultResponderId: null });
    const stopped = await waitForFrame(turnFrame(sleeper.id, "turn.completed"), "removed member stopped", 12_000, start);
    // the hang fake reports an interrupt as an early exit; either way it ended
    expect(stopped.event.ok).toBe(false);
    const lines = () => frames.slice(start).filter((f) => f.kind === "message" && f.threadId === group.threadId).map((f) => f.message.tool?.name);
    expect(lines()).toEqual(expect.arrayContaining(["Extra joined the room", "Sleeper left the room"]));
  }, 20_000);

  it("validates room settings", async () => {
    const solo = await makeBot("Solo", "happy");
    const other = await makeBot("Other", "happy");
    const group = (await api("POST", "/api/groups", { name: "Valid room", memberIds: [solo.id] })).body.group;
    const patch = (body: unknown) => api("PATCH", `/api/groups/${group.id}`, body);

    expect((await patch({ maxHops: 26 })).status).toBe(400);
    expect((await patch({ maxHops: 0 })).status).toBe(400);
    expect((await patch({ maxHops: 1.5 })).status).toBe(400);
    expect((await patch({ handoffs: "sometimes" })).status).toBe(400);
    expect((await patch({ turnIdleMinutes: 0 })).status).toBe(400);
    expect((await patch({ defaultResponderId: other.id })).status).toBe(400);
    expect((await patch({ memberIds: [] })).status).toBe(400);
    expect((await patch({ name: "  " })).status).toBe(400);
    expect((await patch({ autoHandoffs: false })).body.group.handoffs).toBe("off");
    expect((await patch({ turnIdleMinutes: 45, maxHops: 25, name: " Renamed " })).body.group)
      .toMatchObject({ turnIdleMinutes: 45, maxHops: 25, name: "Renamed" });
    expect((await patch({ turnIdleMinutes: null })).body.group.turnIdleMinutes).toBeNull();
  });
});
