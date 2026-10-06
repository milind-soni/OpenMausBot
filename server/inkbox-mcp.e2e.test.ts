import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { harnessMcpRequest } from "./harness-mcp-proxy.ts";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("mounts host-owned Inkbox tools only for the configured bot and gates actual provider writes", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_TOOL_CALLS: "[]" });
  const { url, dataDir, logPath } = fixture.info;
  const providerLog = join(dataDir, "inkbox-provider-calls.jsonl");
  const key = "synthetic-private-inkbox-mcp-key";
  const identity = "c1111111-1111-4111-8111-111111111111";
  let child: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, expected = 200): Promise<any> => {
    const res = await fetch(`${url}${path}`, { method, headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const value = await res.json(); expect(res.status, JSON.stringify(value)).toBe(expected); return value;
  };
  const calls = (): Array<{ method: string; params: { name?: string } }> => existsSync(providerLog)
    ? readFileSync(providerLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const evidence: Record<string, unknown> = { fixtureUrl: url, externalRequestsBlocked: true };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Inkbox tools fixture", useDefaults: false }, 201)).bot;
    const other = (await api("POST", "/api/bots", { name: "Unconnected fixture", useDefaults: false }, 201)).bot;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const prelude = join(dataDir, "synthetic-inkbox-mcp-fetch.mjs");
    writeFileSync(prelude, `
      import { appendFileSync } from "node:fs";
      const original = globalThis.fetch;
      const key = process.env.OMB_INKBOX_API_KEY;
      const identity = process.env.OMB_INKBOX_IDENTITY_ID;
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.hostname === "inkbox.ai") {
          if (new Headers(init?.headers).get("x-api-key") !== key) throw new Error("Wrong synthetic credential");
          if (url.pathname === "/api/v1/api-keys/self") return Response.json({status:"active",scoped_identity_id:identity});
          if (url.pathname !== "/mcp") throw new Error("Unexpected synthetic provider endpoint");
          const body = JSON.parse(init.body);
          appendFileSync(${JSON.stringify(providerLog)}, JSON.stringify(body)+"\\n", {mode:0o600});
          if(body.method === "notifications/initialized") return new Response(null,{status:202});
          const result = body.method === "initialize" ? {protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}
            : body.method === "tools/list" ? {tools:[
              {name:"inkbox_identity_get",inputSchema:{type:"object"}},
              {name:"inkbox_email_send",inputSchema:{type:"object"},annotations:{readOnlyHint:true}},
              {name:"inkbox_call_create",inputSchema:{type:"object"}},
              {name:"inkbox_slack_send",inputSchema:{type:"object"}},
              {name:"inkbox_a2a_task_send",inputSchema:{type:"object"}}]}
            : body.method === "resources/read" ? {contents:[{uri:body.params.uri,mimeType:"application/pdf",blob:"cGRm"}]}
            : {content:[{type:"text",text:"synthetic-provider-success"}, ...(body.params.name === "inkbox_identity_get" ? [{type:"resource_link",uri:"inkbox://files/document",name:"document.pdf"}] : [])]};
          return Response.json({jsonrpc:"2.0",id:body.id,result},{headers:{"mcp-session-id":"fixture-session"}});
        }
        if (url.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname)) return original(input,init);
        throw new Error("External network forbidden in Inkbox fixture");
      };
    `, { mode: 0o600 });
    const log = openSync(logPath, "a", 0o600);
    try {
      child = spawn(process.execPath, ["--experimental-strip-types", "--import", prelude, fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", log, log],
        env: { ...verificationServerEnvironment({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_TOOL_CALLS: "[]" }, dataDir, Number(new URL(url).port)),
          OMB_INKBOX_API_KEY: key, OMB_INKBOX_SIGNING_SECRET: "synthetic-signing-key", OMB_INKBOX_IDENTITY_ID: identity,
          OMB_INKBOX_OWNER_PHONE: "+14155550123", OMB_INKBOX_BOT_ID: bot.id },
      });
    } finally { closeSync(log); }
    await expect.poll(async () => { try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; } }, { timeout: 20_000 }).toBe(true);
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Use my connected Inkbox tools.", threadId: bot.threadId }, 202);
    await expect.poll(() => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.inkbox; } catch { return undefined; } }, { timeout: 15_000 }).toBeTruthy();
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const wrapped = dump.mcpConfig.mcpServers.inkbox;
    const mounted = wrapped.env?.OMB_GATE_UPSTREAM ? JSON.parse(wrapped.env.OMB_GATE_UPSTREAM) : wrapped;
    expect(mounted.args.at(-1)).toBe("inkbox");
    expect(JSON.stringify(mounted)).not.toContain(key);
    expect(Object.keys(mounted.env).every(name => ["ELECTRON_RUN_AS_NODE", "OMB_HARNESS_URL", "OMB_INKBOX_MCP_TOKEN"].includes(name))).toBe(true);
    const relay = async (method: string, params: unknown = {}, token = mounted.env.OMB_INKBOX_MCP_TOKEN) => {
      const res = await fetch(`${url}/api/internal/inkbox/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(20_000) });
      return { status: res.status, body: await res.json() as any };
    };
    const listed = await relay("tools/list");
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools.map((tool: any) => tool.name)).toEqual(["inkbox_identity_get", "inkbox_email_send", "inkbox_call_create", "inkbox_slack_send", "inkbox_a2a_task_send", "inkbox_resource_read"]);
    expect(JSON.stringify(listed)).not.toContain(key);
    expect((await relay("tools/call", { name: "inkbox_identity_get" })).body.result.content[0].text).toBe("synthetic-provider-success");
    const resource = await harnessMcpRequest({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "inkbox_resource_read", arguments: { uri: "inkbox://files/document" } } },
      { url, token: mounted.env.OMB_INKBOX_MCP_TOKEN, kind: "inkbox" }) as any;
    expect(resource.result.content[0].text).toContain("Unparsed binary file");
    expect(resource.result.content[0].text).toContain("cGRm");
    expect(calls().filter(call => call.method === "resources/read")).toHaveLength(1);
    evidence.protectedResourceRead = true;
    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages as any[];
    let lastRequest = "";
    const decide = async (behavior: "allow" | "deny") => {
      const open = async () => (await messages()).findLast(message => message.card?.outboundRequest && !message.card.answered && message.card.requestId !== lastRequest);
      await expect.poll(open, { timeout: 10_000 }).toBeTruthy();
      const message = await open(); lastRequest = message.card.requestId;
      expect(message).toMatchObject({ turnId: expect.any(String), requestMessageId: expect.any(String) });
      expect(message.card.subtitle).toContain("recipient@example.test");
      await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: lastRequest, behavior });
    };
    const denied = relay("tools/call", { name: "inkbox_email_send", arguments: { to: "recipient@example.test", text: "Denied fixture" } });
    await decide("deny"); expect((await denied).body.result.isError).toBe(true);
    expect(calls().filter(call => call.method === "tools/call" && call.params.name === "inkbox_email_send")).toHaveLength(0);
    const approved = relay("tools/call", { name: "inkbox_email_send", arguments: { to: "recipient@example.test", text: "Approved fixture" } });
    await decide("allow"); expect((await approved).body.result.content[0].text).toBe("synthetic-provider-success");
    expect(calls().filter(call => call.method === "tools/call" && call.params.name === "inkbox_email_send")).toHaveLength(1);
    const held = relay("tools/call", { name: "inkbox_email_send", arguments: { to: "recipient@example.test", text: "Stop fixture" } });
    await expect.poll(async () => (await messages()).some(message => message.card?.outboundRequest && !message.card.answered), { timeout: 5000 }).toBe(true);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    // Revoked turn authority releases the hold without a stale decision.
    expect((await held).status).not.toBe(200);
    expect((await relay("tools/list")).status).toBe(401);
    expect(calls().filter(call => call.method === "tools/call" && call.params.name === "inkbox_email_send")).toHaveLength(1);
    rmSync(fixture.fixtureDumpPath, { force: true });
    await api("POST", `/api/bots/${other.id}/messages`, { text: "No Inkbox tools here.", threadId: other.threadId }, 202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 10_000 }).toBe(true);
    expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.inkbox).toBeUndefined();
    Object.assign(evidence, { configuredBotOnly: true, deniedNotSent: true, approvedOnce: true, revokedNotSent: true, exposedCredential: false, providerCalls: calls() });
  } finally {
    await waitForExit(child, { signal: "SIGTERM" }); await fixture.close();
    const evidencePath = `${logPath}.inkbox-mcp.json`;
    writeFileSync(evidencePath, JSON.stringify({ ...evidence, fixtureRemoved: !existsSync(dataDir) }, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 90_000);
