/* oxlint-disable anti-slop/no-runtime-typeof -- ACP and HTTP JSON are runtime protocol boundaries in this dependency-free fixture. */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("fixture-acp 1.0.0\n");
  process.exit(0);
}
if (argv[0] === "status" || argv[0] === "whoami") {
  process.stdout.write('{"isAuthenticated":true}\n');
  process.exit(0);
}
if (argv[0] === "models" || argv.includes("--list-models")) {
  process.stdout.write("auto - Auto (default)\n");
  process.exit(0);
}

let buffer = "";
let agentsIntegration = null;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function integrationEnvironment() {
  const entries = Array.isArray(agentsIntegration?.env) ? agentsIntegration.env : [];
  return Object.fromEntries(entries.flatMap((entry) => {
    const parsed = record(entry);
    return typeof parsed.name === "string" && typeof parsed.value === "string" ? [[parsed.name, parsed.value]] : [];
  }));
}

async function runCanonicalAction(promptText) {
  const env = integrationEnvironment();
  const origin = env.OMB_HARNESS_URL;
  const token = env.OMB_COMMS_TOKEN;
  const botId = env.OMB_BOT_ID;
  const threadId = env.OMB_THREAD_ID;
  if (!origin || !token || !botId || !threadId) throw new Error("canonical action fixture integration is incomplete");
  const deny = promptText.includes("[benchmark-deny]");
  const toolName = deny ? "GITHUB_ADD_ISSUE_COMMENT" : "GITHUB_CREATE_ISSUE";
  const argumentsValue = deny
    ? { account_id: "ca_fixture_alpha", owner: "example-org", repo: "sample-repo", issue_number: 17, body: "Synthetic comment that must not be sent." }
    : { account_id: "ca_fixture_alpha", owner: "example-org", repo: "sample-repo", title: "Prepare synthetic release note", body: "Synthetic benchmark only." };
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const authorized = await fetch(`${origin}/api/internal/action-policy/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ botId, threadId, identity: "Fixture Profile", provider: "github", name: toolName, arguments: argumentsValue }),
  });
  const authorizationBody = record(await authorized.json().catch(() => null));
  let reconciliation = null;
  if (authorized.status === 200 && authorizationBody.decision === "allow") {
    const receiptHash = createHash("sha256").update("fixture-provider-receipt-v1").digest("hex");
    const response = await fetch(`${origin}/api/internal/action-policy/result`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        botId,
        threadId,
        proposalId: authorizationBody.proposalId,
        workId: authorizationBody.workId,
        ok: true,
        receiptHash,
        reference: `connector-receipt:sha256:${receiptHash}`,
      }),
    });
    reconciliation = { status: response.status, body: record(await response.json().catch(() => null)) };
  }
  const receipt = {
    toolName,
    authorization: { status: authorized.status, decision: authorizationBody.decision ?? null },
    reconciliation: reconciliation ? { status: reconciliation.status, workStatus: reconciliation.body.status ?? null } : null,
  };
  if (process.env.FAKE_ACP_ACTION_DUMP) appendFileSync(process.env.FAKE_ACP_ACTION_DUMP, `${JSON.stringify(receipt)}\n`);
  return reconciliation
    ? `Synthetic connector action: authorization ${authorized.status} ${authorizationBody.decision}; reconciliation ${reconciliation.status} ${reconciliation.body.status}.`
    : `Synthetic connector action: authorization ${authorized.status} ${authorizationBody.decision}.`;
}

async function handle(raw) {
  const message = record(raw);
  if (typeof message.method !== "string") return;
  const params = record(message.params);
  switch (message.method) {
    case "initialize":
      result(message.id, { protocolVersion: 1, authMethods: [{ id: "cached_token" }], _meta: { modelState: { currentModelId: "auto" } } });
      return;
    case "authenticate":
    case "session/set_model":
    case "session/set_mode":
    case "session/set_config_option":
      result(message.id, {});
      return;
    case "session/new":
    case "session/load": {
      const servers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
      agentsIntegration = servers.map(record).find((entry) => entry.name === "agents") ?? agentsIntegration;
      result(message.id, {
        sessionId: "fixture-action-session",
        models: { currentModelId: "default[]", availableModels: [{ modelId: "default[]", name: "Auto" }] },
      });
      return;
    }
    case "session/prompt": {
      const prompt = Array.isArray(params.prompt) ? record(params.prompt[0]).text : "";
      try {
        const summary = await runCanonicalAction(typeof prompt === "string" ? prompt : "");
        send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: summary } } } });
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error);
        send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `Synthetic connector action failed: ${summary}` } } } });
      }
      result(message.id, { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } });
      return;
    }
    case "session/cancel":
      return;
    default:
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        void handle(JSON.parse(line));
      } catch {}
    }
    newline = buffer.indexOf("\n");
  }
});
