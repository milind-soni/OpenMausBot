import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { APPROVAL_REVIEW_RUBRIC } from "../shared/approval-review-policy.ts";
import { waitForExit } from "./testing/cleanup.ts";

// The model can choose content, but the tool can only append to one fixed
// artifact inside the disposable fixture. No model-supplied path is executed.
const MCP_FIXTURE = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'approval-fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'write_file', description: 'Write the disposable review artifact', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }] };
  else if (request.method === 'tools/call' && request.params.name === 'write_file') {
    appendFileSync(process.env.FIXTURE_ARTIFACT, request.params.arguments.content + '\\n');
    result = { content: [{ type: 'text', text: 'created verification artifact' }] };
  } else result = { content: [{ type: 'text', text: 'Unknown fixture operation' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

type ChatRequest = {
  model: string;
  stream?: boolean;
  reasoning_effort?: string;
  messages: Array<{ role: string; content?: string; tool_calls?: unknown }>;
  tools?: Array<{ function: { name: string; description?: string } }>;
};

it("reviews exact Auto actions through real HTTP, persists settings, and leaves Ask and Full unchanged", async () => {
  const mainModel = "fixture-working-model";
  const reviewerModel = "fixture-review-model";
  const requests: ChatRequest[] = [];
  const connectorExecutions: unknown[] = [];
  const evidence: unknown[] = [];
  let verdict = "allow";
  let marker = "";
  let releaseReview: (() => void) | undefined;
  let reviewerEntered = false;
  let upstreamOrigin = "";
  const upstream = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [mainModel, reviewerModel].map(id => ({ id, context_length: 131072 })) }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = body ? JSON.parse(body) : {};
    if (req.url?.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tool_router/session/fixture-session") {
        res.end(JSON.stringify({ session_id: "fixture-session", mcp: { type: "http", url: upstreamOrigin + "/mcp" },
          config: { user_id: "fixture-user", multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true } } }));
      } else res.end(JSON.stringify({ items: [{ slug: "gmail", connected_account: { id: "fixture-account", status: "ACTIVE" } }] }));
      return;
    }
    if (req.url === "/mcp") {
      res.setHeader("content-type", "application/json");
      if (rpc.id === undefined) { res.statusCode = 202; res.end(); return; }
      let result: unknown;
      if (rpc.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "connector-fixture", version: "1" } };
      else if (rpc.method === "tools/list") result = { tools: [{ name: "GMAIL_SEND_EMAIL", description: "Record the disposable connector send", inputSchema: { type: "object", properties: { recipient: { type: "string" }, body: { type: "string" } }, required: ["recipient", "body"] } }] };
      else if (rpc.method === "tools/call") {
        connectorExecutions.push(rpc.params);
        result = { content: [{ type: "text", text: "recorded synthetic send" }] };
      } else result = {};
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      return;
    }
    const supplied = rpc as ChatRequest;
    requests.push(supplied);
    const review = supplied.messages.some(message => message.content?.includes("independent execution reviewer"));
    const frame = (delta: unknown, finish_reason: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    if (review) {
      reviewerEntered = true;
      if (verdict === "held") await new Promise<void>(resolve => { releaseReview = resolve; });
      const content = verdict === "malformed" ? "This is not a verdict" : JSON.stringify({ decision: verdict === "held" ? "allow" : verdict, reason: `Fixture ${verdict} decision` });
      res.setHeader("content-type", supplied.stream ? "text/event-stream" : "application/json");
      res.end(supplied.stream ? frame({ content }, "stop") + "data: [DONE]\n\n" : JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const newestUser = supplied.messages.findLastIndex(message => message.role === "user");
    if (supplied.messages.slice(newestUser + 1).some(message => message.role === "tool")) {
      res.end(frame({ content: "Fixture action finished." }, "stop") + "data: [DONE]\n\n");
    } else {
      const connector = marker.startsWith("connector-");
      const name = supplied.tools?.find(tool => tool.function.description?.includes(connector ? "disposable connector send" : "disposable review artifact"))?.function.name;
      const args = connector ? { recipient: "fixture@example.invalid", body: marker } : { content: marker };
      res.end(frame({ tool_calls: [{ index: 0, id: `call-${marker}`, type: "function", function: { name: name ?? (connector ? "composio_GMAIL_SEND_EMAIL" : "review_fixture_write_file"), arguments: JSON.stringify(args) } }] }, "tool_calls") + "data: [DONE]\n\n");
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing approval fixture endpoint");
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
  const fixture = await launchVerificationServer().catch(async error => {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    throw error;
  });
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const cli = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const messages = async (thread: string): Promise<any[]> => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages;
  const restart = async () => {
    const log = openSync(fixture.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...verificationServerEnvironment({}, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
        OMB_COMPOSIO_API: upstreamOrigin + "/api", OMB_COMPOSIO_TOOLKITS_API: upstreamOrigin + "/api" },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(fixture.info.url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  try {
    await api("PUT", "/api/config", { openaiCompat: { key: "synthetic-approval-key", url: `http://127.0.0.1:${address.port}/v1`, model: mainModel } });
    await api("POST", "/api/instances/openaiCompat/refresh-models", {});
    expect((await api("GET", "/api/config")).approvalReview).toEqual({});
    const selection = { instanceId: "openaiCompat", model: reviewerModel };
    const settings = { model: selection, instructions: "Keep writes within the disposable artifact." };
    await api("PUT", "/api/config", { approvalReview: settings });
    expect((await api("GET", "/api/config")).approvalReview).toEqual(settings);
    await api("PUT", "/api/config", { approvalReview: { model: { instanceId: "missing-fixture", model: reviewerModel } } }, 400);
    expect((await api("GET", "/api/config")).approvalReview).toEqual(settings);

    const artifact = join(fixture.info.dataDir, "review-artifact.txt");
    const script = join(fixture.info.dataDir, "review-mcp.mjs");
    writeFileSync(script, MCP_FIXTURE);
    await api("POST", "/api/mcp/servers", { name: "review_fixture", command: process.execPath, args: [script], env: { FIXTURE_ARTIFACT: artifact }, enabled: true }, 201);
    await api("PATCH", "/api/mcp/servers/review_fixture", { enabled: true });
    const bot = (await cli("new-bot", "--name", "Approval review fixture")).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    await cli("set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", mainModel);
    await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["review_fixture"], toolScope: { allow: ["mcp:review_fixture:write_file"] } });
    const full = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Full access fixture" }, 201)).task;

    // Restart only the owned fixture to check persisted review settings and connector setup.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"));
    saved.find((entry: any) => entry.id === bot.id).tasks.find((task: any) => task.threadId === full.threadId).approvalMode = "full";
    writeFileSync(join(fixture.info.dataDir, "bots.json"), JSON.stringify(saved));
    const configFile = join(fixture.info.dataDir, "config.json");
    const savedConfig = JSON.parse(readFileSync(configFile, "utf8"));
    savedConfig.composio = { apiKey: "ak_synthetic_fixture", userId: "fixture-user", sessionId: "fixture-session" };
    writeFileSync(configFile, JSON.stringify(savedConfig));
    await restart();
    expect((await api("GET", "/api/config")).approvalReview).toEqual(settings);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, { approvalMode: "auto", acknowledgeLocalAuto: true });

    const reviewRequests = () => requests.filter(request => request.messages.some(message => message.content?.includes("independent execution reviewer")));
    const run = async (name: string, decision: string, mode = "auto", thread = bot.activeTaskId) => {
      marker = name; verdict = decision; reviewerEntered = false;
      if (thread === bot.activeTaskId) await api("PATCH", `/api/bots/${bot.id}/tasks/${thread}`, { approvalMode: mode, acknowledgeLocalAuto: mode === "auto" });
      const before = reviewRequests().length;
      const beforeMessages = new Set((await messages(thread)).map(row => row.id));
      await cli("send", "--bot", bot.id, "--task", thread, "--text", `Write fixture marker ${name} to the disposable review artifact.`);
      let state = await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "20");
      const rows = (await messages(thread)).filter(row => !beforeMessages.has(row.id));
      const cards = rows.filter(row => row.card?.requestId);
      const shouldAsk = mode === "ask" || ["ask", "malformed"].includes(decision) && mode === "auto";
      if (shouldAsk) {
        expect(state.status).toBe("needs-user");
        expect(cards).toHaveLength(1);
        expect(cards[0].card.answered).toBeFalsy();
        expect(existsSync(artifact) ? readFileSync(artifact, "utf8") : "").not.toContain(name + "\n");
        await api("POST", `/api/bots/${bot.id}/respond`, { threadId: thread, requestId: cards[0].card.requestId, behavior: "allow" });
        state = await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "20");
      } else expect(cards, JSON.stringify({ state: state.status, rows, reviewed: reviewRequests().slice(before) })).toHaveLength(0);
      expect(reviewRequests().length - before).toBe(mode === "auto" ? 1 : 0);
      const contents = existsSync(artifact) ? readFileSync(artifact, "utf8") : "";
      if (decision === "deny" && mode === "auto") {
        expect(contents).not.toContain(name + "\n");
        expect(rows.some(row => row.tool?.ok === false && row.tool?.name.includes("Denied"))).toBe(true);
      } else {
        expect(state.status).toBe("settled");
        expect(contents.split("\n").filter(line => line === name)).toHaveLength(1);
      }
      return reviewRequests().slice(before);
    };

    const selected = (await run("selected-allow", "allow"))[0]!;
    expect(selected.model).toBe(reviewerModel);
    expect(selected.reasoning_effort).toBeUndefined();
    expect(selected.messages.filter(message => message.role === "system"))
      .toEqual([{ role: "system", content: APPROVAL_REVIEW_RUBRIC }]);
    expect(selected).not.toHaveProperty("tools");
    expect(JSON.stringify(selected.messages)).toContain(settings.instructions);
    const reviewPrompt = selected.messages.find(message => message.role === "user")!.content!;
    expect(JSON.parse(reviewPrompt.split("Review input (JSON data):\n")[1]!)).toMatchObject({
      action: { tool: "review_fixture_write_file", arguments: { content: "selected-allow" } },
      additionalConstraints: settings.instructions,
    });
    expect(JSON.stringify(selected.messages)).toContain("Write fixture marker selected-allow");
    const defaultReviewModel = { instanceId: "openaiCompat", model: reviewerModel };
    await api("PUT", "/api/config", { approvalReview: { model: defaultReviewModel } });
    expect((await api("GET", "/api/config")).approvalReview).toEqual({ model: defaultReviewModel, instructions: settings.instructions });
    const defaulted = (await run("review-default-effort", "allow"))[0]!;
    expect(defaulted.model).toBe(reviewerModel);
    expect(defaulted.reasoning_effort).toBeUndefined();
    await run("automatic-denial", "deny");
    await run("review-asks-human", "ask");
    await run("malformed-falls-back", "malformed");
    await run("ask-mode", "deny", "ask");
    await run("full-mode", "deny", "full", full.threadId);
    await api("PUT", "/api/config", { approvalReview: { model: null } });
    expect((await api("GET", "/api/config")).approvalReview).toEqual({ instructions: settings.instructions });
    const following = (await run("follow-working-model", "allow"))[0]!;
    expect(following.model).toBe(mainModel);
    expect(following.reasoning_effort).toBeUndefined();
    const workingRequests = requests.filter(request => !request.messages.some(message => message.content?.includes("independent execution reviewer")));
    expect(workingRequests.length).toBeGreaterThan(0);
    expect(workingRequests.every(request => request.reasoning_effort === undefined)).toBe(true);

    marker = "settings-race"; verdict = "held"; reviewerEntered = false;
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Write fixture marker settings-race to the disposable artifact.");
    await expect.poll(() => reviewerEntered, { timeout: 10_000 }).toBe(true);
    await api("PUT", "/api/config", { approvalReview: { instructions: "Changed during active Auto turn." } }, 409);
    expect((await api("GET", "/api/config")).approvalReview.instructions).toBe(settings.instructions);
    releaseReview?.();
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20")).status).toBe("settled");
    const decisions = (await api("GET", "/api/decisions")).decisions;
    expect(decisions.some((row: any) => row.source === "auto-review" && row.decision === "auto-approved")).toBe(true);
    expect(decisions.some((row: any) => row.source === "auto-review" && row.decision === "auto-denied")).toBe(true);

    marker = "stopped-review"; verdict = "held"; reviewerEntered = false;
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Write fixture marker stopped-review to the disposable artifact.");
    await expect.poll(() => reviewerEntered, { timeout: 10_000 }).toBe(true);
    await cli("interrupt", "--bot", bot.id, "--task", bot.activeTaskId);
    releaseReview?.();
    await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20");
    expect(readFileSync(artifact, "utf8")).not.toContain("stopped-review\n");

    marker = "room-auto-allow"; verdict = "allow";
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "auto", acknowledgeLocalAuto: true });
    const group = (await api("POST", "/api/groups", { name: "Review room fixture", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } }, 201)).group;
    const beforeRoom = reviewRequests().length;
    await cli("send-channel", "--channel", group.id, "--text", "Write fixture marker room-auto-allow to the disposable artifact.");
    expect((await cli("wait", "--channel", group.id, "--timeout", "20")).status).toBe("settled");
    expect(reviewRequests().length - beforeRoom).toBe(1);
    expect((await messages(group.threadId)).some(row => row.card?.requestId)).toBe(false);
    expect(readFileSync(artifact, "utf8").split("\n").filter(line => line === marker)).toHaveLength(1);

    const connectorBot = (await cli("new-bot", "--name", "Connector approval fixture")).bot;
    await cli("set-model", "--bot", connectorBot.id, "--instance", "openaiCompat", "--model", mainModel);
    await api("PATCH", `/api/bots/${connectorBot.id}`, { toolScope: { allow: ["mcp:composio:GMAIL_SEND_EMAIL"] } });
    await api("PATCH", `/api/bots/${connectorBot.id}/tasks/${connectorBot.activeTaskId}`, { approvalMode: "auto", acknowledgeLocalAuto: true });
    for (const decision of ["allow", "deny", "ask"]) {
      marker = `connector-${decision}`; verdict = decision;
      const reviewCount = reviewRequests().length;
      const executionCount = connectorExecutions.length;
      const beforeIds = new Set((await messages(connectorBot.activeTaskId)).map(row => row.id));
      await cli("send", "--bot", connectorBot.id, "--task", connectorBot.activeTaskId, "--text", `Send the synthetic message ${marker} to fixture@example.invalid.`);
      let state = await cli("wait", "--bot", connectorBot.id, "--task", connectorBot.activeTaskId, "--timeout", "20");
      const cards = (await messages(connectorBot.activeTaskId)).filter(row => !beforeIds.has(row.id) && row.card?.requestId);
      if (decision === "ask") {
        expect(state.status).toBe("needs-user");
        expect(cards).toHaveLength(1);
        expect(connectorExecutions).toHaveLength(executionCount);
        await api("POST", `/api/bots/${connectorBot.id}/respond`, { threadId: connectorBot.activeTaskId, requestId: cards[0].card.requestId, behavior: "allow" });
        state = await cli("wait", "--bot", connectorBot.id, "--task", connectorBot.activeTaskId, "--timeout", "20");
      } else expect(cards).toHaveLength(0);
      expect(reviewRequests().length - reviewCount).toBe(1);
      expect(connectorExecutions.length - executionCount).toBe(decision === "deny" ? 0 : 1);
      if (decision !== "deny") {
        expect(state.status).toBe("settled");
        expect(connectorExecutions.at(-1)).toEqual({ name: "GMAIL_SEND_EMAIL", arguments: { recipient: "fixture@example.invalid", body: marker } });
      }
      expect((await messages(connectorBot.activeTaskId)).filter(row => !beforeIds.has(row.id) && row.card?.requestId)).toHaveLength(decision === "ask" ? 1 : 0);
    }

    marker = "connector-scope-refusal"; verdict = "held"; reviewerEntered = false;
    const beforeRefusal = connectorExecutions.length;
    await cli("send", "--bot", connectorBot.id, "--task", connectorBot.activeTaskId, "--text", "Send the synthetic scope refusal fixture message.");
    await expect.poll(() => reviewerEntered, { timeout: 10_000 }).toBe(true);
    await api("PATCH", `/api/bots/${connectorBot.id}`, { connectorScopes: { apps: { gmail: "read" } } });
    releaseReview?.();
    await cli("wait", "--bot", connectorBot.id, "--task", connectorBot.activeTaskId, "--timeout", "20");
    expect(connectorExecutions).toHaveLength(beforeRefusal);
    expect((await api("GET", "/api/decisions")).decisions.some((row: any) => row.botId === connectorBot.id && row.source === "connector-scope" && row.decision === "auto-denied")).toBe(true);
  } finally {
    releaseReview?.();
    const evidencePath = `${fixture.info.logPath}.approval-review.json`;
    writeFileSync(evidencePath, JSON.stringify({ evidence, providerRequests: requests, connectorExecutions }, null, 2), { mode: 0o600 });
    console.info(`Approval-review evidence: ${evidencePath}`);
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 150_000);
