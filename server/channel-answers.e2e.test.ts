// Signed carrier messages, the real server and native permission broker. The
// only transport outside loopback is a synthetic, in-process Inkbox response.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { OptionCardData } from "../shared/wire.ts";
import { waitForExit } from "./testing/cleanup.ts";

interface Task { threadId: string; approvalMode: string; autoApprove: boolean; alwaysAllow: string[] }
interface Bot { id: string; threadId: string; tasks: Task[] }
interface Message { id: string; role: string; kind: string; text?: string; turnId?: string; requestMessageId?: string; replyToId?: string; turnTerminal?: boolean; turnSucceeded?: boolean; card?: OptionCardData }
interface Send { url: string; body: { to: string; text: string }; redirect: string }
interface Answer { t: string; id: string; behavior: string; message?: string; always?: boolean }

it("answers signed owner questions and exact one-time approvals on the original live task", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_TOOL_CALLS: "[]" });
  const { url, dataDir, logPath } = fixture.info;
  const apiKey = "synthetic-channel-answers-api-key";
  const signingSecret = "synthetic-channel-answers-signing-secret";
  const identityId = "synthetic-channel-answers-identity";
  const ownerPhone = "+14155550123";
  const sendFile = join(dataDir, "synthetic-channel-sends.jsonl");
  const releaseFile = join(dataDir, "release-channel-turn");
  const promptsFile = join(dataDir, "channel-engine-prompts.jsonl");
  const sockets: Socket[] = [];
  const relayed: unknown[] = [];
  let brokerOrigin = "";
  const broker = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tool_router/session/fixture-session") return res.end(JSON.stringify({ session_id: "fixture-session", mcp: { type: "http", url: brokerOrigin + "/mcp" },
      config: { user_id: "fixture-user", multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true } } }));
    if (req.url === "/mcp") {
      relayed.push(body);
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "synthetic-email-sent" }] } }));
    }
    return res.end(JSON.stringify({ items: [{ slug: "gmail", connected_account: { id: "fixture-account", status: "ACTIVE" } }] }));
  });
  let child: ChildProcess | undefined;
  const evidence: Record<string, unknown> = { fixtureUrl: url, liveHttpsForbidden: true };
  const api = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(`${url}${path}`, { method, headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as T;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const messages = async (threadId: string) => (await api<{ messages: Message[] }>("GET", `/api/threads/${threadId}/messages?limit=100`)).messages;
  const sends = (): Send[] => existsSync(sendFile) ? readFileSync(sendFile, "utf8").trim().split("\n").filter(Boolean).map(row => JSON.parse(row) as Send) : [];
  let nextSendCount = 0;
  const nextSent = async (): Promise<string> => {
    const count = ++nextSendCount;
    await expect.poll(() => sends().length, { timeout: 15_000, interval: 100 }).toBeGreaterThanOrEqual(count);
    const text = sends()[count - 1]!.body.text;
    return text.startsWith("The bot is still working") ? nextSent() : text;
  };
  try {
    await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
    brokerOrigin = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
    const bot = (await api<{ bot: Bot }>("POST", "/api/bots", { name: "Channel answer fixture", useDefaults: false }, 201)).bot;
    const selectedBaseline = await messages(bot.threadId);
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configFile = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.composio = { apiKey: "ak_synthetic_channel_fixture", userId: "fixture-user", sessionId: "fixture-session" };
    writeFileSync(configFile, JSON.stringify(config));
    const prelude = join(dataDir, "synthetic-channel-fetch.mjs");
    writeFileSync(prelude, `
      import { appendFileSync } from "node:fs";
      const original = globalThis.fetch;
      const expectedKey = process.env.OMB_INKBOX_API_KEY;
      const identity = process.env.OMB_INKBOX_IDENTITY_ID;
      globalThis.fetch = async function(input, init) {
        const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (target.href === "https://inkbox.ai/api/v1/api-keys/self" && init?.method === "GET") {
          if (new Headers(init.headers).get("x-api-key") !== expectedKey) return new Response("{}", {status:401});
          return Response.json({ scoped_identity_id: identity, status: "active" });
        }
        if (target.href === "https://inkbox.ai/api/v1/imessage/messages" && init?.method === "POST") {
          if (new Headers(init.headers).get("x-api-key") !== expectedKey) return new Response("{}", {status:401});
          appendFileSync(${JSON.stringify(sendFile)}, JSON.stringify({url:target.href,body:JSON.parse(init.body),redirect:init.redirect}) + "\\n", {mode:0o600});
          return Response.json({ id: "synthetic-send", status: "queued" }, {status:201});
        }
        if (target.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) return original(input, init);
        throw new Error("Network access outside the owned loopback fixture is forbidden");
      };
    `, { mode: 0o600 });
    const log = openSync(logPath, "a", 0o600);
    try {
      child = spawn(process.execPath, ["--experimental-strip-types", "--import", prelude, fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", log, log],
        env: { ...verificationServerEnvironment({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_RELEASE: releaseFile, FAKE_CLAUDE_PROMPTS: promptsFile }, dataDir, Number(new URL(url).port)),
          OMB_COMPOSIO_API: brokerOrigin + "/api", OMB_COMPOSIO_TOOLKITS_API: brokerOrigin + "/api",
          OMB_INKBOX_API_KEY: apiKey, OMB_INKBOX_SIGNING_SECRET: signingSecret, OMB_INKBOX_IDENTITY_ID: identityId, OMB_INKBOX_OWNER_PHONE: ownerPhone, OMB_INKBOX_BOT_ID: bot.id },
      });
    } finally { closeSync(log); }
    await expect.poll(async () => { try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, { timeout: 20_000, interval: 100 }).toBe(true);
    const state = async () => (await api<{ bots: Bot[] }>("GET", "/api/bots")).bots.find(row => row.id === bot.id)!;
    const status = await api<{ ingress: { baseUrl: string }; messaging: { configured: boolean } }>("GET", "/api/trusted-contacts");
    expect(status.messaging.configured).toBe(true);
    const post = async (id: string, text: string, raw?: string) => {
      const body = raw ?? JSON.stringify({ id, event_type: "imessage.received", timestamp: new Date().toISOString(), agent_identity_id: identityId,
        data: { message: { id, direction: "inbound", is_group: false, participants: null, recipients: null, remote_number: ownerPhone, sender_number: null, message_type: "message", content: text } } });
      const stamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", signingSecret).update(`synthetic-request.${stamp}.${body}`).digest("hex");
      const response = await fetch(`${status.ingress.baseUrl}/inkbox`, { method: "POST", headers: { "content-type": "application/json", "x-inkbox-request-id": "synthetic-request",
        "x-inkbox-timestamp": stamp, "x-inkbox-signature": `sha256=${signature}` }, body, signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBe(202);
      return body;
    };
    const originalText = "Prepare my fixture report and ask me for its choices and approvals.";
    await post("channel_start", originalText);
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.ogb?.args.at(-1); } catch { return undefined; }
    }, { timeout: 15_000 }).toEqual(expect.any(String));
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const afterStart = await state();
    expect(afterStart.tasks).toHaveLength(bot.tasks.length + 1);
    const task = afterStart.tasks.find(row => !bot.tasks.some(old => old.threadId === row.threadId))!;
    expect(task).toMatchObject({ approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
    const ask = async (tool: string, input: unknown, kind?: string, threadId = task.threadId, socketPath = dump.mcpConfig.mcpServers.ogb.args.at(-1)) => {
      const socket = connect(socketPath);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      const id = randomUUID();
      const answers: Answer[] = [];
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          answers.push(JSON.parse(buffer.slice(0, newline)) as Answer);
          buffer = buffer.slice(newline + 1);
        }
      });
      socket.write(JSON.stringify({ t: "ask", id, tool, input, ...(kind ? { kind } : {}) }) + "\n");
      const card = async () => (await messages(threadId)).find(message => message.card?.requestId === id);
      await expect.poll(card, { timeout: 10_000 }).toBeTruthy();
      return { id, answers, card };
    };

    const first = await ask("AskUserQuestion", { questions: [{ question: "Which format should I prepare?", options: [{ label: "Brief", description: "One page" }, { label: "Detailed", description: "With supporting evidence" }] }] }, "question");
    const firstPrompt = await nextSent();
    expect(firstPrompt).toContain("Which format should I prepare?");
    expect(firstPrompt).toContain("1. Brief — One page");
    expect(firstPrompt).toContain("2. Detailed — With supporting evidence");
    const firstCard = await first.card();
    await post("channel_numeric_answer", "2");
    await expect.poll(() => first.answers, { timeout: 10_000 }).toEqual([expect.objectContaining({ t: "answer", id: first.id, behavior: "answer", message: expect.stringContaining("Q: Which format should I prepare?\nA: Detailed") })]);
    expect((await first.card())?.card?.answered).toBe("answer");

    const multi = await ask("AskUserQuestion", { questions: [
      { question: "Which sections?", multiSelect: true, options: [{ label: "Costs" }, { label: "Schedule" }, { label: "Risks" }] },
      { question: "Any additional instructions?", options: [] },
    ] }, "question");
    expect(await nextSent()).toContain("Question 1 of 2");
    await post("channel_multi_answer", "1,3");
    const secondPrompt = await nextSent();
    expect(secondPrompt).toContain("Question 2 of 2");
    expect(secondPrompt).toContain("Any additional instructions?");
    expect(multi.answers).toEqual([]);
    await post("channel_freeform_answer", "Include the assumptions and keep it concise.");
    await expect.poll(() => multi.answers.length, { timeout: 10_000 }).toBe(1);
    expect(multi.answers[0]).toMatchObject({ id: multi.id, behavior: "answer" });
    expect(multi.answers[0]!.message).toContain("Q: Which sections?\nA: Costs, Risks");
    expect(multi.answers[0]!.message).toContain("Q: Any additional instructions?\nA: Include the assumptions and keep it concise.");

    const firstApproval = await ask("Bash", { command: "echo channel-first-approval" });
    const approvalPrompt = await nextSent();
    expect(approvalPrompt).toContain("echo channel-first-approval");
    expect(approvalPrompt).toMatch(/yes.*approve/i);
    expect(approvalPrompt).not.toMatch(/APPROVE [A-F0-9]{8}/);
    await post("channel_wrong_code", "APPROVE WRONG123");
    expect(await nextSent()).toContain('Reply "yes"');
    expect(firstApproval.answers).toEqual([]);
    const approvedRaw = await post("channel_approve", "yes");
    await expect.poll(() => firstApproval.answers, { timeout: 10_000 }).toEqual([expect.objectContaining({ id: firstApproval.id, behavior: "allow" })]);
    expect(firstApproval.answers[0]).not.toHaveProperty("always");

    const secondApproval = await ask("Bash", { command: "echo channel-second-approval" });
    const nextApprovalPrompt = await nextSent();
    expect(nextApprovalPrompt).toContain("echo channel-second-approval");
    await post("channel_approve", "yes", approvedRaw);
    await post("channel_stale_code", "APPROVE WRONG123");
    expect(await nextSent()).toContain('Reply "yes"');
    expect(firstApproval.answers).toHaveLength(1);
    expect(secondApproval.answers).toEqual([]);
    expect((await secondApproval.card())?.card?.answered).toBeUndefined();
    await post("channel_deny", "no");
    await expect.poll(() => secondApproval.answers, { timeout: 10_000 }).toEqual([expect.objectContaining({ id: secondApproval.id, behavior: "deny" })]);

    // Exercise the separate harness-owned outbound hold with the real turn's
    // connector capability; no minted test token can substitute for its lease.
    const connector = dump.mcpConfig.mcpServers.composio.env;
    const relay = () => fetch(connector.OMB_CONNECTOR_UPSTREAM_URL, { method: "POST",
      headers: { "content-type": "application/json", ...JSON.parse(connector.OMB_CONNECTOR_UPSTREAM_HEADERS) },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "GMAIL_SEND_EMAIL", arguments: { to: "recipient@fixture.test", subject: "Fixture report", body: "Synthetic test email only." } } }),
      signal: AbortSignal.timeout(20_000),
    }).then(async response => { expect(response.status).toBe(200); return await response.json() as { result: { isError?: boolean } }; });
    const email = relay();
    void email.catch(() => {});
    const emailPrompt = await nextSent();
    expect(emailPrompt).toContain("recipient@fixture.test");
    expect(emailPrompt).toContain("GMAIL_SEND_EMAIL");
    expect(emailPrompt).not.toMatch(/APPROVE [A-F0-9]{8}/);
    expect(relayed).toHaveLength(0);
    await post("channel_email_stale_code", "APPROVE WRONG123");
    expect(await nextSent()).toContain('Reply "yes"');
    expect(relayed).toHaveLength(0);
    const emailRaw = await post("channel_email_approve", "approve");
    expect((await email).result.isError).not.toBe(true);
    expect(relayed).toHaveLength(1);
    const deniedEmail = relay();
    void deniedEmail.catch(() => {});
    const deniedEmailPrompt = await nextSent();
    expect(deniedEmailPrompt).toContain("GMAIL_SEND_EMAIL");
    await post("channel_email_approve", "approve", emailRaw);
    await post("channel_email_deny", "deny");
    expect((await deniedEmail).result.isError).toBe(true);
    expect(relayed).toHaveLength(1);
    await post("channel_automatic", "approve for me");
    expect(await nextSent()).toContain("Messaging approvals: Automatic");
    const automatic = await ask("Bash", { command: "echo channel-automatic-approval" });
    await expect.poll(() => automatic.answers, { timeout: 10_000 }).toEqual([expect.objectContaining({ id: automatic.id, behavior: "allow" })]);
    expect(await nextSent()).toContain("Automatically approved:");
    const autoQuestion = await ask("AskUserQuestion", { questions: [{ question: "Still ask me in automatic mode?", options: [{ label: "Yes, ask" }] }] }, "question");
    expect(await nextSent()).toContain("Still ask me in automatic mode?");
    expect(autoQuestion.answers).toEqual([]);
    await post("channel_automatic_question", "1");
    await expect.poll(() => autoQuestion.answers.length).toBe(1);
    await post("channel_ask_first", "ask me first");
    expect(await nextSent()).toContain("Messaging approvals: Ask first");
    const revoked = await ask("Bash", { command: "echo channel-revoked-approval" });
    expect(await nextSent()).toContain("echo channel-revoked-approval");
    expect(revoked.answers).toEqual([]);
    await post("channel_revoked_deny", "deny");
    await expect.poll(() => revoked.answers).toEqual([expect.objectContaining({ id: revoked.id, behavior: "deny" })]);
    expect((await state()).tasks.find(row => row.threadId === task.threadId)).toMatchObject({ approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
    writeFileSync(releaseFile, "release only after the exact pending answers arrived");
    expect(await nextSent()).toBe("released");

    const finalState = await state();
    expect(finalState.tasks).toHaveLength(afterStart.tasks.length);
    expect(finalState.threadId).toBe(bot.threadId);
    expect(await messages(bot.threadId)).toEqual(selectedBaseline);
    const finalMessages = await messages(task.threadId);
    expect(finalMessages.filter(message => message.role === "user" && message.kind === "text").map(message => message.text)).toEqual([originalText]);
    expect(finalMessages).toContainEqual(expect.objectContaining({ role: "bot", text: "released", turnTerminal: true, turnSucceeded: true, turnId: firstCard!.turnId, requestMessageId: firstCard!.requestMessageId }));
    expect(readFileSync(promptsFile, "utf8").trim().split("\n")).toHaveLength(1);
    expect((await api<{ rules: unknown[] }>("GET", `/api/bots/${bot.id}/command-allowlist`)).rules).toEqual([]);
    expect(dump.env).not.toHaveProperty("OMB_INKBOX_API_KEY");
    expect(dump.env).not.toHaveProperty("OMB_INKBOX_SIGNING_SECRET");
    expect(dump.argv).not.toContain("--dangerously-skip-permissions");
    for (const send of sends()) expect(send).toMatchObject({ url: "https://inkbox.ai/api/v1/imessage/messages", body: { to: ownerPhone }, redirect: "error" });
    Object.assign(evidence, { botId: bot.id, originalThreadId: task.threadId, turnId: firstCard!.turnId,
      questionAnswers: [...first.answers, ...multi.answers], approvalAnswers: [...firstApproval.answers, ...secondApproval.answers, ...automatic.answers, ...revoked.answers],
      automaticPreferenceAndRevocation: true, questionsRemainManual: true, nativeTaskRemainsAsk: true,
      sends: sends(), relayed, oneEnginePrompt: true, noNewTaskForReplies: true, canonicalContinuation: true, exactOnceApprovals: true });

    // A provider may finish while its durable question is still visible. Its
    // later carrier answer must continue that question's task exactly once.
    rmSync(releaseFile);
    await post("channel_late_start", "NEW Ask a question that I will answer after the provider finishes.");
    await expect.poll(() => readFileSync(promptsFile, "utf8").trim().split("\n").length, { timeout: 15_000 }).toBe(2);
    const beforeLateAnswer = await state();
    const lateTask = beforeLateAnswer.tasks.find(row => !finalState.tasks.some(old => old.threadId === row.threadId))!;
    expect(beforeLateAnswer.tasks).toHaveLength(finalState.tasks.length + 1);
    const lateDump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const late = await ask("AskUserQuestion", { questions: [{ question: "Which report should I resume?", options: [{ label: "Short report" }, { label: "Full report" }] }] }, "question", lateTask.threadId, lateDump.mcpConfig.mcpServers.ogb.args.at(-1));
    expect(await nextSent()).toContain("2. Full report");
    const lateCard = await late.card();
    writeFileSync(releaseFile, "finish the provider before the person replies");
    await expect.poll(async () => (await messages(lateTask.threadId)).some(message => message.turnTerminal && message.turnSucceeded), { timeout: 10_000 }).toBe(true);
    expect((await late.card())?.card?.answered).toBeUndefined();
    const lateAnswerRaw = await post("channel_late_answer", "2");
    expect(await nextSent()).toBe("released");
    expect((await state()).tasks).toHaveLength(beforeLateAnswer.tasks.length);
    const lateMessages = await messages(lateTask.threadId);
    const reply = lateMessages.find(message => message.role === "user" && message.replyToId === lateCard!.id)!;
    expect(reply.text).toContain("Q: Which report should I resume?\nA: Full report");
    expect(lateMessages).toContainEqual(expect.objectContaining({ text: "released", requestMessageId: reply.id, turnTerminal: true, turnSucceeded: true }));
    expect((await late.card())?.card?.answered).toBe("answer");
    await post("channel_late_answer", "2", lateAnswerRaw);
    await post("channel_late_status", "STATUS");
    expect(await nextSent()).toBe("released");
    expect(readFileSync(promptsFile, "utf8").trim().split("\n")).toHaveLength(3);
    Object.assign(evidence, { lateQuestionThreadId: lateTask.threadId, lateAnswerMessageId: reply.id, lateContinuationExactlyOnce: true, sends: sends() });
  } catch (error) {
    const bots = await api<{ bots: Bot[] }>("GET", "/api/bots").catch(() => null);
    const transcripts = bots ? await Promise.all(bots.bots.flatMap(bot => bot.tasks.map(async task => ({ threadId: task.threadId, messages: await messages(task.threadId) })))) : [];
    Object.assign(evidence, { sends: sends(), bots, transcripts });
    throw error;
  } finally {
    for (const socket of sockets) socket.destroy();
    await waitForExit(child, { signal: "SIGTERM" });
    await fixture.close();
    await new Promise<void>(resolve => broker.close(() => resolve()));
    const evidencePath = `${logPath}.channel-answers.json`;
    writeFileSync(evidencePath, JSON.stringify({ ...evidence, fixtureRemoved: !existsSync(dataDir) }, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 90_000);
