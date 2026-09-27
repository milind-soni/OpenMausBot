// Real HTTP + account gateway + workspace children + model tool calls. Every
// external service is an owned loopback fixture; no live account is touched.
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { startFakeRobinhoodChain } from "./testing/fake-robinhood-chain.ts";
import { startFakeHostedComputers, hostedFixtureConfig, HOSTED_PNG } from "./testing/fake-hosted-computers.ts";

function browser(base: string) {
  const jar = new Map<string, string>();
  const seen: string[] = [];
  return { seen, async request(path: string, method = "GET", body?: unknown) {
    const res = await fetch(base + path, { method,
      headers: { origin: base, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";"); const index = pair!.indexOf("=");
      jar.set(pair!.slice(0, index), pair!.slice(index + 1));
    }
    const text = await res.text(); seen.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : {}, text };
  } };
}

it.each(["orgo", "daytona"] as const)("%s: Admin enables it and member turns use isolated persistent computers", async providerName => {
  const codingJobs: any[] = [];
  const codingRequests: any[] = [];
  const provider = await startFakeHostedComputers(async (machine, command) => {
    const input = JSON.parse(Buffer.from(command.match(/'([A-Za-z0-9+/=]+)'$/)![1], "base64").toString());
    codingJobs.push(input);
    const response = await fetch(input.url + "/responses", { method: "POST", headers: {
      authorization: `Bearer ${input.token}`, "content-type": "application/json" }, body: JSON.stringify({ input: input.prompt, stream: true, model: "caller-cannot-pick" }) });
    const data = await response.text();
    if (!response.ok) return { exitCode: 0, result: JSON.stringify({ status: "failed", text: `Fixture coding gateway ${response.status}: ${data}` }) };
    const write = input.prompt.match(/^save (\S+)$/);
    if (write) machine.files.set("code.txt", write[1]);
    return { exitCode: 0, result: JSON.stringify({ status: "completed", text: `Coding receipt: ${machine.files.get("code.txt") ?? "empty"}` }) };
  });
  const chain = await startFakeRobinhoodChain();
  let seq = 0;
  const model = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (req.url?.endsWith("/responses")) {
      codingRequests.push({ body, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `gen-coding-${codingRequests.length}`, usage: { cost: 0.01 } } })}\n\n`);
      return;
    }
    if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
    const user = [...body.messages].reverse().find((m: any) => m.role === "user" && typeof m.content === "string");
    const ask = String(user?.content ?? "").trim().split("\n").at(-1) ?? "";
    const replies = body.messages.slice(body.messages.lastIndexOf(user) + 1).filter((m: any) => m.role === "tool");
    const tools = (body.tools ?? []).map((t: any) => t.function.name);
    const write = ask.match(/^save (\S+)$/);
    let call = replies.length === 0 && tools.includes("computer_execute") && (write || ask === "show");
    let delta = call ? { tool_calls: [{ index: 0, id: `c-${++seq}`, type: "function", function: { name: "computer_execute",
      arguments: JSON.stringify({ command: write ? `printf %s ${write[1]} > note.txt` : "cat note.txt" }) } }] }
      : { content: `Result: ${replies.map((m: any) => String(m.content)).join(" | ") || "no computer tool"}` };
    if (ask.startsWith("code ") && tools.includes("computer_code_start")) {
      const result = replies.length ? JSON.parse(JSON.parse(replies.at(-1).content).result) : null;
      if (!result || result.state === "running") {
        call = true;
        delta = { tool_calls: [{ index: 0, id: `code-${++seq}`, type: "function", function: {
          name: result ? "computer_code_status" : "computer_code_start",
          arguments: JSON.stringify(result ? { taskId: result.taskId } : { project: "fixture-project", prompt: ask.slice(5) }),
        } }] };
      }
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.001 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined,
    origin, undefined, undefined, undefined, {
      coding: providerName === "daytona",
      founderEmails: ["founder@example.test"],
      payments: { rpc: chain.url, treasury: "0x85E3C2D8f776d9D05b14E108F368070CbD8C1639", confirmations: 1, scanSeconds: 5 },
    }, { orgo: provider.url, daytona: provider.url });
  const base = fixture.info.url;
  const owner = async (path: string, method = "GET", body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  const signIn = async (who: ReturnType<typeof browser>, email: string) => {
    expect((await who.request("/api/auth/magic/start", "POST", { email })).status).toBe(200);
    const outbox = join(fixture.info.dataDir, "mail-outbox");
    const message = readdirSync(outbox).sort().reverse().map(file => JSON.parse(readFileSync(join(outbox, file), "utf8"))).find(m => m.to === email);
    const token = decodeURIComponent(String(message.link).split("#login=")[1]!);
    expect((await who.request("/api/auth/magic/verify", "POST", { token, label: "Fixture browser" })).body).toMatchObject({ ok: true, destination: "workspace" });
    expect((await who.request("/api/credits/status")).body).toMatchObject({ onFreePlan: true, starterGranted: true });
  };
  const turn = async (who: ReturnType<typeof browser>, bot: any, text: string) => {
    const before = ((await who.request(`/api/threads/${bot.threadId}/messages`)).body.messages ?? []).length;
    const sent = await who.request(`/api/bots/${bot.id}/messages`, "POST", { text });
    expect(sent.status, sent.text).toBeLessThan(300);
    let report = "";
    await expect.poll(async () => {
      const messages: any[] = (await who.request(`/api/threads/${bot.threadId}/messages`)).body.messages ?? [];
      const card = messages.find(m => m.card?.requestId && !m.card.answered)?.card;
      if (card) { await who.request(`/api/bots/${bot.id}/respond`, "POST", { threadId: bot.threadId, requestId: card.requestId, behavior: "allow" }); return false; }
      const done = messages.slice(before).find(m => m.role === "bot" && m.text?.startsWith("Result:"));
      if (done) report = done.text;
      const bots = (await who.request("/api/bots")).body.bots ?? [];
      return Boolean(done) && !bots.find((b: any) => b.id === bot.id)?.busy;
    }, { timeout: 45_000, interval: 200 }).toBe(true);
    return report;
  };
  try {
    // Disabled until Admin has tested credentials. Validation is read-only.
    const deskBot = (await owner("/api/bots", "POST", { name: "Founder" })).body.bot;
    expect((await owner(`/api/bots/${deskBot.id}`, "PATCH", { cloudBackend: providerName })).status).toBe(409);
    const rejected = await owner("/api/config", "PUT", { hostedComputers: { ...hostedFixtureConfig, orgo: { ...hostedFixtureConfig.orgo, apiKey: "bad-key" } } });
    expect(rejected.status).toBe(400);
    const saved = await owner("/api/config", "PUT", { hostedComputers: { ...hostedFixtureConfig, defaultProvider: providerName } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.hostedComputers).toMatchObject({ defaultProvider: providerName, [providerName]: { configured: true, enabled: true } });
    expect(JSON.stringify(saved.body)).not.toContain("fixture-secret");
    expect(provider.machines).toHaveLength(0);
    // A blank UI key is omitted; non-secret edits retain the saved credential.
    expect((await owner("/api/config", "PUT", { hostedComputers: { defaultProvider: providerName } })).status).toBe(200);
    expect((await owner("/api/bots")).body.bots.find((b: any) => b.id === deskBot.id)?.cloudBackend).toBe(deskBot.cloudBackend);
    const alice = browser(base); const bob = browser(base);
    await signIn(alice, "alice@example.test");
    await signIn(bob, "bob@example.test");
    const a = (await alice.request("/api/bots", "POST", { name: "Alice" })).body.bot;
    const b = (await bob.request("/api/bots", "POST", { name: "Bob" })).body.bot;
    expect(a.cloudBackend).toBe(providerName); expect(b.cloudBackend).toBe(providerName);
    for (const [who, bot] of [[alice, a], [bob, b]] as const) {
      const cfg = await who.request("/api/config");
      expect(cfg.body).toMatchObject({ personalWorkspace: true, features: { computers: true } });
      expect(cfg.body).not.toHaveProperty("hostedComputers");
      expect((await who.request("/api/config", "PUT", { hostedComputers: hostedFixtureConfig })).status).toBe(403);
      expect((await who.request(`/api/bots/${bot.id}`, "PATCH", { computer: "cloud" })).status).toBe(200);
    }
    expect(await turn(alice, a, "save ALICE_SECRET")).not.toContain("no computer tool");
    expect(await turn(bob, b, "show")).not.toContain("ALICE_SECRET");
    expect(await turn(bob, b, "save BOB_SECRET")).not.toContain("no computer tool");
    expect(await turn(alice, a, "show")).toContain("ALICE_SECRET");
    if (providerName === "daytona") {
      const balance = async (who: ReturnType<typeof browser>) => (await who.request("/api/credits/status")).body.balanceUsd as number;
      const aliceBefore = await balance(alice), bobBefore = await balance(bob);
      expect(await turn(alice, a, "code save ALICE_CODE_SECRET")).toContain("ALICE_CODE_SECRET");
      const aliceAfter = await balance(alice);
      expect(aliceBefore - aliceAfter).toBeGreaterThanOrEqual(0.01);
      expect(await balance(bob)).toBe(bobBefore);
      expect(await turn(bob, b, "code show")).toContain("Coding receipt: empty");
      expect(bobBefore - await balance(bob)).toBeGreaterThanOrEqual(0.01);
      expect(await balance(alice)).toBe(aliceAfter);
      expect(await turn(alice, a, "code show")).toContain("ALICE_CODE_SECRET");
      expect(codingJobs).toHaveLength(3);
      expect(codingRequests).toHaveLength(3);
      expect(codingRequests.every(r => r.body.model === "openai/coding-fixture")).toBe(true);
      expect(new URL(codingJobs[0].url).pathname.split("/")[3]).not.toBe(new URL(codingJobs[1].url).pathname.split("/")[3]);
      for (const job of codingJobs) {
        expect((await fetch(job.url + "/lease", { headers: { authorization: `Bearer ${job.token}` } })).status).toBe(403);
        expect([...alice.seen, ...bob.seen].join("\n")).not.toContain(job.token);
      }
    }
    expect(provider.machines).toHaveLength(2);
    expect((await bob.request(`/api/bots/${a.id}/computer`)).status).toBeGreaterThanOrEqual(400);
    const screen = await alice.request(`/api/bots/${a.id}/computer/screenshot`, "POST", {});
    expect(screen.status, screen.text).toBe(200);
    expect(screen.body).toEqual({ png: HOSTED_PNG, format: "png" });
    expect((await alice.request(`/api/bots/${a.id}/computer/sleep`, "POST", {})).status).toBe(200);
    expect((await alice.request(`/api/bots/${a.id}/computer`)).body.state).toBe("stopped");
    expect((await alice.request(`/api/bots/${a.id}/computer/provision`, "POST", {})).status).toBe(200);
    expect(await turn(alice, a, "show")).toContain("ALICE_SECRET");
    expect(provider.machines).toHaveLength(2);
    for (const step of ["exec", "join", "remove"]) expect((await alice.request(`/api/bots/${a.id}/computer/${step}`, "POST", {})).status).toBe(403);
    expect((await alice.request("/api/internal/hosted-computer/execute", "POST", { command: "id" })).status).toBeGreaterThanOrEqual(400);
    provider.fail(true);
    const failed = await alice.request(`/api/bots/${a.id}/computer/screenshot`, "POST", {});
    provider.fail(false);
    expect(failed.status).toBe(502);
    for (const text of [...alice.seen, ...bob.seen]) {
      expect(text).not.toMatch(/orgo-fixture-secret|daytona-fixture-secret|workspace-fixture|desktop-fixture/);
      for (const m of provider.machines) { expect(text).not.toContain(m.id); expect(text).not.toContain(m.name); }
    }
    expect(provider.unknown).toEqual([]);
  } finally {
    await fixture.close(); await provider.close(); await chain.close();
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  }
}, 120_000);
