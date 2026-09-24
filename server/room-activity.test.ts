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
    home = mkdtempSync(join(tmpdir(), "gbs-room-activity-"));
    const dataDirectory = join(home, ".gbs");
    mkdirSync(dataDirectory);
    writeFileSync(join(dataDirectory, "config.json"), JSON.stringify({
      instances: {
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
      },
    }));
    child = spawn(process.execPath, [join(serverDirectory, "index.ts")], {
      cwd: join(serverDirectory, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        GBS_PORT: String(port),
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
});
