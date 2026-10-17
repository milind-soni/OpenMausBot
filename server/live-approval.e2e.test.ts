import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

// A model may only append to this fixture's fixed artifact; it never supplies a path.
const mcp = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); if(r.id===undefined)return;
 const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:
 r.method==='tools/list'?{tools:[{name:'write',description:'Fixture mode write',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}:
 r.method==='tools/call'?(appendFileSync(process.env.ARTIFACT,'write\\n'),{content:[{type:'text',text:'written'}]}):{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`;

it.each([
  ["ask", "full", false, false],
  ["ask", "full", false, true],
  ["ask", "auto", true, false],
  ["auto", "full", false, false],
  ["full", "ask", true, false],
] as const)("saves %s to %s during a held model response and uses upstream tool gates", async (initial, selected, cardExpected, allThreads) => {
  let release: (() => void) | undefined;
  let entered = false;
  let requests = 0;
  const model = createServer(async (req, res) => {
    if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture-live" }] })); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const first = requests++ === 0;
    if (first) { entered = true; await new Promise<void>(resolve => { release = resolve; }); }
    const name = body.tools?.find((tool: { function: { description?: string } }) => tool.function.description?.includes("Fixture mode write"))?.function.name;
    res.setHeader("content-type", "text/event-stream");
    const delta = first ? { tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name, arguments: "{}" } }] } : { content: "Fixture finished." };
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const address = model.address(); if (!address || typeof address === "string") throw new Error("fixture model address missing");
  const fixture = await launchVerificationServer();
  try {
    const { url, dataDir } = fixture.info;
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json() as any; expect(response.status, JSON.stringify(value)).toBeLessThan(300); return value;
    };
    await api("PUT", "/api/config", { openaiCompat: { key: "synthetic", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-live" } });
    const created = await runControlOmb(["new-bot", "--name", "Live mode fixture", "--url", url]) as { bot: { id: string; activeTaskId: string } };
    const bot = created.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    await runControlOmb(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-live", "--url", url]);
    const artifact = join(dataDir, "mode-artifact.txt"); const script = join(dataDir, "mode-mcp.mjs"); writeFileSync(script, mcp);
    await api("POST", "/api/mcp/servers", { name: "livefx", command: process.execPath, args: [script], env: { ARTIFACT: artifact }, enabled: true });
    await api("PATCH", `/api/mcp/servers/livefx`, { enabled: true });
    await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["livefx"], approvalMode: initial, acknowledgeLocalAuto: initial === "auto" });
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Run the fixture write.", "--url", url]);
    await expect.poll(() => entered, { timeout: 15_000 }).toBe(true);
    await api("PATCH", allThreads ? `/api/bots/${bot.id}` : `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, {
      approvalMode: selected, acknowledgeLocalAuto: selected === "auto", ...(allThreads ? { applyToAllThreads: true } : {}),
    });
    const saved = { bot: (await api("GET", "/api/bots?messages=0")).bots.find((row: { id: string }) => row.id === bot.id) };
    expect(saved.bot.tasks.find((task: { threadId: string }) => task.threadId === bot.activeTaskId).approvalMode).toBe(selected);
    release!();
    if (cardExpected) {
      let requestId: string | undefined;
      await expect.poll(async () => {
        const messages = (await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages;
        requestId = messages.find((message: { card?: { requestId?: string; answered?: boolean } }) => message.card?.requestId && !message.card.answered)?.card.requestId;
        return Boolean(requestId);
      }, { timeout: 15_000 }).toBe(true);
      expect(existsSync(artifact)).toBe(false);
      await api("POST", `/api/threads/${bot.activeTaskId}/respond`, { requestId, behavior: "deny" });
    }
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((row: { id: string }) => row.id === bot.id).tasks.find((task: { threadId: string }) => task.threadId === bot.activeTaskId).busy, { timeout: 15_000 }).toBe(false);
    expect(existsSync(artifact)).toBe(!cardExpected);
    if (!cardExpected) expect(readFileSync(artifact, "utf8")).toBe("write\n");
  } finally { release?.(); await fixture.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }
}, 45_000);
