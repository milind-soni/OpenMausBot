import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

interface Task { threadId: string; title: string; approvalMode: string; autoApprove: boolean; alwaysAllow: string[] }
interface Bot { id: string; threadId: string; tasks: Task[]; approvalMode: string }
interface Message { id: string; role: string; kind: string; text?: string; turnTerminal?: boolean; turnSucceeded?: boolean; card?: { requestId?: string; answered?: boolean } }
interface Send { url: string; body: { to: string; text: string }; redirect: string }

it("continues signed owner messages in one unselected Ask task without leaking keys or approving older work", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_REPLIES: '["**owner fixture reply**"]' });
  const { url, dataDir, logPath } = fixture.info;
  const apiKey = "synthetic-inkbox-api-key-owner-e2e";
  const signingSecret = "synthetic-inkbox-signing-secret-owner-e2e";
  const ownerPhone = "+14155550123";
  const identityId = "synthetic-identity-owner-e2e";
  const sendFile = join(dataDir, "synthetic-inkbox-sends.jsonl");
  const oldDump = join(dataDir, "older-approval-cli-dump.json");
  let child: ChildProcess | undefined;
  let discoveredPhoneNumberId: string | undefined;
  let socket: Socket | undefined;
  const api = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as T; expect(response.status, JSON.stringify(result)).toBe(expected); return result;
  };
  const messages = async (threadId: string) => (await api<{ messages: Message[] }>("GET", `/api/threads/${threadId}/messages?limit=100`)).messages;
  const sends = (): Send[] => existsSync(sendFile) ? readFileSync(sendFile, "utf8").trim().split("\n").filter(Boolean).map(row => JSON.parse(row) as Send) : [];
  const evidence: Record<string, unknown> = { fixtureUrl: url, liveHttpsForbidden: true };
  try {
    const bot = (await api<{ bot: Bot }>("POST", "/api/bots", { name: "Owner messaging fixture", useDefaults: false }, 201)).bot;
    const older = (await api<{ bot: Bot }>("POST", "/api/bots", { name: "Existing approval fixture", useDefaults: false }, 201)).bot;
    const baseline = await messages(bot.threadId);
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    // Seed Full defaults only in this stopped, launcher-owned fixture. Every
    // carrier task must explicitly reset all inherited permission fields.
    const botsFile = join(dataDir, "bots.json");
    const persisted = JSON.parse(readFileSync(botsFile, "utf8")) as Bot[];
    const stored = persisted.find(row => row.id === bot.id)!;
    Object.assign(stored, { approvalMode: "full", autoApprove: true, alwaysAllow: ["Bash", "Read"] });
    for (const task of stored.tasks) Object.assign(task, { approvalMode: "full", autoApprove: true, alwaysAllow: ["Bash", "Read"] });
    writeFileSync(botsFile, JSON.stringify(persisted));
    const configFile = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.instances.olderApproval = { ...config.instances.claude, displayName: "Existing approval fake", environment: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: oldDump } };
    config.instances.followup = { ...config.instances.claude, displayName: "Followup fake", environment: { FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_REPLIES: '["**followup fixture reply**"]' } };
    writeFileSync(configFile, JSON.stringify(config));
    const prelude = join(dataDir, "synthetic-inkbox-fetch.mjs");
    writeFileSync(prelude, `
      import { appendFileSync } from "node:fs";
      const original = globalThis.fetch;
      const expectedKey = process.env.OMB_INKBOX_API_KEY;
      const identity = process.env.OMB_INKBOX_IDENTITY_ID;
      const sendFile = ${JSON.stringify(sendFile)};
      globalThis.fetch = async function(input, init) {
        const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (target.href === "https://inkbox.ai/api/v1/api-keys/self" && init?.method === "GET") {
          if (new Headers(init.headers).get("x-api-key") !== expectedKey) return new Response("{}", {status:401});
          return Response.json({ scoped_identity_id: identity, status: "active" });
        }
        if (target.href === "https://inkbox.ai/api/v1/imessage/messages" && init?.method === "POST") {
          if (new Headers(init.headers).get("x-api-key") !== expectedKey) return new Response("{}", {status:401});
          appendFileSync(sendFile, JSON.stringify({url:target.href,body:JSON.parse(init.body),redirect:init.redirect}) + "\\n", {mode:0o600});
          return Response.json({ id: "synthetic-send", status: "queued" }, {status:201});
        }
        if (target.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(target.hostname)) return original(input, init);
        throw new Error("Network access outside the owned loopback fixture is forbidden");
      };
    `, { mode: 0o600 });
    const startServer = async () => {
      const log = openSync(logPath, "a", 0o600);
      try {
        child = spawn(process.execPath, ["--experimental-strip-types", "--import", prelude, fileURLToPath(new URL("./index.ts", import.meta.url))], {
          cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", log, log],
          env: { ...verificationServerEnvironment({ FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_REPLIES: '["**owner fixture reply**"]' }, dataDir, Number(new URL(url).port)),
            OMB_INKBOX_API_KEY: apiKey, OMB_INKBOX_SIGNING_SECRET: signingSecret, OMB_INKBOX_IDENTITY_ID: identityId, OMB_INKBOX_OWNER_PHONE: ownerPhone, OMB_INKBOX_BOT_ID: bot.id,
            ...(discoveredPhoneNumberId ? { OMB_INKBOX_PHONE_NUMBER_ID: discoveredPhoneNumberId } : {}) },
        });
      } finally { closeSync(log); }
      await expect.poll(async () => { try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, { timeout: 20_000, interval: 100 }).toBe(true);
    };
    await startServer();
    const state = async () => (await api<{ bots: Bot[] }>("GET", "/api/bots")).bots.find(row => row.id === bot.id)!;
    expect((await state()).approvalMode).toBe("full");
    const status = await api<{ ingress: { baseUrl: string }; messaging: { configured: boolean } }>("GET", "/api/trusted-contacts");
    expect(status.messaging.configured).toBe(true);
    const post = async (id: string, text: string, raw?: string) => {
      const body = raw ?? JSON.stringify({ id, event_type: "imessage.received", timestamp: new Date().toISOString(), agent_identity_id: identityId,
        data: { message: { id, direction: "inbound", is_group: false, participants: null, recipients: null, remote_number: ownerPhone, sender_number: null, message_type: "message", content: text } } });
      const stamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", signingSecret).update(`synthetic-request.${stamp}.${body}`).digest("hex");
      const response = await fetch(`${status.ingress.baseUrl}/inkbox`, { method: "POST", headers: { "content-type": "application/json", "x-inkbox-request-id": "synthetic-request",
        "x-inkbox-timestamp": stamp, "x-inkbox-signature": `sha256=${signature}` }, body, signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBe(202); return body;
    };
    const firstRaw = await post("owner_event_one", "Please answer the owner fixture.");
    await expect.poll(() => sends().length, { timeout: 20_000, interval: 100 }).toBe(1);
    const afterFirst = await state();
    expect(afterFirst.tasks).toHaveLength(bot.tasks.length + 1);
    expect(afterFirst.threadId).toBe(bot.threadId);
    const firstTask = afterFirst.tasks.find(task => !bot.tasks.some(old => old.threadId === task.threadId))!;
    expect(firstTask).toMatchObject({ title: "iMessage / SMS", approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
    expect(sends()[0]).toEqual({ url: "https://inkbox.ai/api/v1/imessage/messages", body: { to: ownerPhone, text: "owner fixture reply" }, redirect: "error" });
    const firstMessages = await messages(firstTask.threadId);
    expect(firstMessages.some(message => message.text === "Please answer the owner fixture.")).toBe(true);
    expect(firstMessages.some(message => message.text === "**owner fixture reply**" && message.turnTerminal === true && message.turnSucceeded === true)).toBe(true);
    expect(await messages(bot.threadId)).toEqual(baseline);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(dump.env).not.toHaveProperty("OMB_INKBOX_API_KEY");
    expect(dump.env).not.toHaveProperty("OMB_INKBOX_SIGNING_SECRET");
    expect(dump.argv).not.toContain("--dangerously-skip-permissions");
    expect(JSON.stringify(dump)).not.toContain(apiKey);
    expect(JSON.stringify(dump)).not.toContain(signingSecret);
    await post("owner_event_one", "Please answer the owner fixture.", firstRaw);
    expect((await state()).tasks).toHaveLength(afterFirst.tasks.length);
    expect(sends()).toHaveLength(1);

    // Simulate setup discovering an existing phone resource during upgrade.
    discoveredPhoneNumberId = "synthetic-discovered-phone";
    // Restore the durable channel binding in a fresh process before continuing.
    await waitForExit(child, { signal: "SIGTERM" });
    await startServer();

    // Hold a genuine native permission request in another existing Ask task.
    await api("PATCH", `/api/bots/${older.id}/tasks/${older.threadId}`, { modelSelection: { instanceId: "olderApproval", model: "claude-sonnet-5" }, approvalMode: "ask" });
    await api("POST", `/api/bots/${older.id}/messages`, { threadId: older.threadId, text: "Hold the existing permission fixture." }, 202);
    await expect.poll(() => existsSync(oldDump), { timeout: 15_000 }).toBe(true);
    const socketPath = JSON.parse(readFileSync(oldDump, "utf8")).mcpConfig.mcpServers.ogb.args.at(-1) as string;
    socket = connect(socketPath);
    await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
    const requestId = randomUUID();
    let permissionAnswer = "";
    socket.on("data", chunk => { permissionAnswer += chunk; });
    socket.write(JSON.stringify({ t: "ask", id: requestId, tool: "Bash", input: { command: "echo owner-fixture-permission" } }) + "\n");
    const approval = async () => (await messages(older.threadId)).find(message => message.card?.requestId === requestId)?.card;
    await expect.poll(async () => Boolean(await approval()), { timeout: 10_000 }).toBe(true);
    const originalApproval = await approval();
    await api("PATCH", `/api/bots/${bot.id}/tasks/${firstTask.threadId}`, { modelSelection: { instanceId: "followup", model: "claude-sonnet-5" } });
    await post("owner_event_yes", "YES");
    await expect.poll(() => sends().length, { timeout: 20_000, interval: 100 }).toBe(2);
    expect(sends()[1]?.body.text).toBe("followup fixture reply");
    const afterYes = await state();
    expect(afterYes.tasks).toHaveLength(afterFirst.tasks.length);
    expect(afterYes.threadId).toBe(bot.threadId);
    const yesTask = afterYes.tasks.find(task => task.threadId === firstTask.threadId)!;
    expect(yesTask).toMatchObject({ approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
    expect((await messages(yesTask.threadId)).some(message => message.role === "user" && message.text === "YES")).toBe(true);
    expect(await approval()).toEqual(originalApproval);
    expect(permissionAnswer).toBe("");
    // Continuation must recheck Ask mode instead of inheriting an app edit.
    await api("PATCH", `/api/bots/${bot.id}/tasks/${firstTask.threadId}`, { approvalMode: "auto" });
    await post("owner_changed_mode", "Do not run this in Auto mode.");
    await expect.poll(() => sends().length, { timeout: 20_000, interval: 100 }).toBe(3);
    expect(sends()[2]?.body.text).toMatch(/could not be confirmed|Ask task|changed/);
    expect((await messages(firstTask.threadId)).some(message => message.text === "Do not run this in Auto mode.")).toBe(false);
    await post("owner_explicit_new", "NEW Separate fixture request");
    await expect.poll(() => sends().length, { timeout: 20_000, interval: 100 }).toBe(4);
    expect((await state()).tasks).toHaveLength(afterFirst.tasks.length + 1);
    expect(sends()[3]?.body.text).toBe("owner fixture reply");
    const latestDump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(latestDump.env).not.toHaveProperty("OMB_INKBOX_API_KEY");
    expect(latestDump.env).not.toHaveProperty("OMB_INKBOX_SIGNING_SECRET");
    expect(latestDump.argv).not.toContain("--dangerously-skip-permissions");
    const messaging = await api("GET", "/api/trusted-contacts");
    expect(JSON.stringify(messaging)).not.toContain(apiKey);
    expect(JSON.stringify(messaging)).not.toContain(signingSecret);
    await api("POST", `/api/threads/${older.threadId}/respond`, { requestId, behavior: "deny" });
    await api("POST", `/api/bots/${older.id}/interrupt`, { threadId: older.threadId });
    Object.assign(evidence, { botId: bot.id, selectedThreadId: bot.threadId, ownerThreadIds: [firstTask.threadId, yesTask.threadId], sends: sends(), canonicalFinal: true,
      askDefaults: true, duplicateSuppressed: true, olderApprovalUnchangedByYes: true, childCredentialIsolation: true });
  } finally {
    socket?.destroy();
    await waitForExit(child, { signal: "SIGTERM" });
    await fixture.close();
    const evidencePath = `${logPath}.inkbox-owner.json`;
    writeFileSync(evidencePath, JSON.stringify({ ...evidence, fixtureRemoved: !existsSync(dataDir) }, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 90_000);
