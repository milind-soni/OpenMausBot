import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";

import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { GroupTask, WireBot, WireGroup, WireMessage } from "../shared/wire.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

it("keeps live room questions fenced but allows task changes after their turn settles and restarts", async () => {
  const gates = mkdtempSync(join(tmpdir(), "omb-room-question-gates-"));
  const finishGate = join(gates, "finish");
  const env = { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_FINISH_GATE: finishGate };
  const fixture = await launchVerificationServer(env);
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let restarted: ChildProcess | undefined;
  let questionSocket: Socket | undefined;
  const api = async <T = unknown>(method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as T };
    evidence.push({ method, path, body, result });
    return result;
  };
  try {
    const created = await api<{ bot: WireBot }>("POST", "/api/bots", { name: "Room question holder" });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const roomReply = await api<{ group: WireGroup }>("POST", "/api/groups", {
      name: "Question room", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    expect(roomReply.status).toBe(201);
    const room = roomReply.body.group;
    const spare = await api<{ task: GroupTask }>("POST", `/api/groups/${room.id}/tasks`, { title: "Other task" });
    expect(spare.status).toBe(201);
    const spareThreadId = spare.body.task.threadId;
    expect((await api("POST", `/api/groups/${room.id}/tasks/${room.threadId}`, {})).status).toBe(200);
    expect((await api("POST", `/api/groups/${room.id}/messages`, {
      threadId: room.threadId, text: "Ask one question and finish without its answer.",
    })).status).toBe(202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 10_000 }).toBe(true);
    const dump = z.object({ mcpConfig: z.object({ mcpServers: z.object({
      ogb: z.object({ args: z.array(z.string()) }),
    }) }) }).parse(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
    questionSocket = connect(dump.mcpConfig.mcpServers.ogb.args[1]!);
    let socketBuffer = "";
    let providerReply: unknown;
    questionSocket.on("data", (chunk) => {
      socketBuffer += chunk.toString();
      const newline = socketBuffer.indexOf("\n");
      if (newline !== -1) providerReply = JSON.parse(socketBuffer.slice(0, newline));
    });
    await new Promise<void>((resolve, reject) => {
      questionSocket!.once("connect", resolve);
      questionSocket!.once("error", reject);
    });
    const requestId = randomUUID();
    questionSocket.write(JSON.stringify({
      t: "ask", kind: "question", id: requestId, tool: "AskUserQuestion",
      input: { questions: [{ question: "Which file?", options: [{ label: "README" }, { label: "Guide" }] }] },
    }) + "\n");
    const question = async () => (await api<{ messages: WireMessage[] }>("GET", `/api/threads/${room.threadId}/messages`)).body.messages
      .find((message) => message.card?.requestId === requestId)?.card;
    const roomState = async () => (await api<{ groups: WireGroup[] }>("GET", "/api/bots?messages=0")).body.groups
      .find((group) => group.id === room.id)!;
    await expect.poll(question, { timeout: 5_000 }).toMatchObject({ requestType: "question", requestId });
    expect((await roomState()).working).toBe(true);
    const changes: Array<[string, string, unknown?]> = [
      ["POST", `/api/groups/${room.id}/tasks`, { title: "New task" }],
      ["POST", `/api/groups/${room.id}/tasks/${spareThreadId}`, {}],
      ["PATCH", `/api/groups/${room.id}/tasks/${spareThreadId}`, { title: "Renamed task" }],
      ["PATCH", `/api/groups/${room.id}`, { bulletin: "Revised brief" }],
      ["PATCH", `/api/groups/${room.id}`, { memberIds: [bot.id] }],
      ["DELETE", `/api/groups/${room.id}/tasks/${spareThreadId}`],
    ];
    for (const [method, path, body] of changes) {
      expect((await api(method, path, body)).status, `${method} ${path} while live`).toBe(409);
    }

    writeFileSync(finishGate, "finish");
    await expect.poll(async () => (await roomState()).working, { timeout: 5_000 }).toBe(false);
    await expect.poll(() => providerReply, { timeout: 5_000 }).toMatchObject({ behavior: "answer" });
    expect(await question()).toMatchObject({ requestType: "question", requestId });
    expect((await question())!.answered).toBeUndefined();
    expect((await question())!.dismissed).toBeUndefined();
    const settledTask = await api<{ task: GroupTask }>("POST", `/api/groups/${room.id}/tasks`, { title: "Settled question task" });
    expect(settledTask.status).toBe(201);
    expect((await api("POST", `/api/groups/${room.id}/tasks/${spareThreadId}`, {})).status).toBe(200);
    expect((await api("POST", `/api/groups/${room.id}/tasks/${room.threadId}`, {})).status).toBe(200);
    for (const [method, path, body] of changes.slice(2, 5)) {
      expect((await api(method, path, body)).status, `${method} ${path} after settlement`).toBe(200);
    }
    expect((await api("DELETE", `/api/groups/${room.id}/tasks/${settledTask.body.task.threadId}`)).status).toBe(200);

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    questionSocket.destroy();
    questionSocket = undefined;
    const log = openSync(fixture.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: verificationServerEnvironment(env, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await api<{ pid: number }>("GET", "/api/health")).body.pid; } catch { return undefined; }
    }, { timeout: 20_000 }).toBe(restarted.pid);
    expect((await roomState()).working).toBe(false);
    expect((await question())!.answered).toBeUndefined();
    expect((await question())!.dismissed).toBeUndefined();
    for (const [method, path, body] of changes) {
      expect((await api(method, path, body)).status, `${method} ${path} after restart`).toBe(method === "POST" && path.endsWith("/tasks") ? 201 : 200);
    }
    expect((await question())!.answered).toBeUndefined();
    expect((await question())!.dismissed).toBeUndefined();
    expect((await api("POST", `/api/threads/${room.threadId}/respond`, {
      requestId, behavior: "answer", message: "README",
    }))).toMatchObject({ status: 200, body: { ok: true, outcome: "answered", late: true } });
    await expect.poll(question, { timeout: 5_000 }).toMatchObject({ answered: "answer", answeredText: "README", dismissed: false });
  } finally {
    questionSocket?.destroy();
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    await removeTempDir(gates);
    const evidencePath = `${fixture.info.logPath}.room-question-tasks.json`;
    try {
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    } catch (error) {
      console.warn("Could not write room-question test evidence", error);
    }
    const fixtureRemoved = !existsSync(fixture.info.dataDir);
    expect.soft(fixtureRemoved).toBe(true);
    console.info(JSON.stringify({ ...fixture.info, evidencePath, fixtureRemoved }));
  }
}, 45_000);
