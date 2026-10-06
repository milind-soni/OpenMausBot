import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InkboxChannel, readInkboxConfig, type InkboxConfig } from "./inkbox-channel.ts";
import { ChannelConversation } from "./channel-conversation.ts";

const NOW = Date.parse("2026-10-06T10:30:00.038Z");
const OWNER = "+14155550123";
const CONTACT = "+14155550999";
const CONFIG: InkboxConfig = { apiKey: "fixture-key", signingSecret: "fixture-secret", identityId: "identity-fixture", ownerPhone: OWNER, botId: "bot-fixture", phoneNumberId: "number-fixture" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function event(id = "evt_one", phone = OWNER, channel = "imessage") {
  const common = { direction: "inbound", conversation_id: "conversation-fixture", recipients: null };
  return { id, event_type: `${channel}.received`, timestamp: new Date(NOW).toISOString(), data: channel === "imessage"
    ? { message: { ...common, id: "message-fixture", is_group: false, participants: null, remote_number: phone, sender_number: null, content: "hello", message_type: "message" }, contacts: [{ id: "carrier-supplied-untrusted" }], context: { texts: "untrusted history" } }
    : { text_message: { ...common, id: "message-fixture", remote_phone_number: phone, sender_phone_number: phone, local_phone_number: "+14155550000", type: "sms", text: "hello" }, recipient_phone_number: null } };
}

function signed(raw: string, seconds = Math.floor(NOW / 1000)) {
  const stamp = String(seconds);
  return { "content-type": "application/json", "x-inkbox-request-id": "request-fixture", "x-inkbox-timestamp": stamp,
    "x-inkbox-signature": `sha256=${createHmac("sha256", CONFIG.signingSecret).update(`request-fixture.${stamp}.`).update(raw).digest("hex")}` };
}

async function fixture(options: { reply?: string; sendStatus?: number; sendThrow?: boolean; keyScope?: string | null; keyStatus?: string; file?: string; approvalMode?: () => "ask" | "auto"; onOwnerReceived?: (text: string, metadata: { receivedAt: number; eventTimestamp?: number }) => void; onOwner?: ConstructorParameters<typeof InkboxChannel>[0]["onOwner"]; onContact?: (contactId: string, eventId: string, text: string) => Promise<string>; config?: InkboxConfig | false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-inkbox-"));
  const file = options.file ?? join(dir, "inbox.json");
  const turns: unknown[][] = [];
  const sends: { url: string; body: unknown; options: RequestInit; disk: unknown }[] = [];
  const keyChecks: string[] = [];
  const channel = new InkboxChannel({ file, approvalMode: options.approvalMode, onOwnerReceived: options.onOwnerReceived, config: options.config === false ? undefined : options.config ?? CONFIG, now: () => NOW, contactForPhone: phone => phone === CONTACT ? "contact-fixture" : null,
    onOwner: options.onOwner ?? (async (id, text) => { turns.push(["owner", id, text]); return options.reply ?? "owner reply"; }),
    onContact: options.onContact ?? (async (contactId, id, text) => { turns.push(["contact", contactId, id, text]); return "contact reply"; }),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") { keyChecks.push(String(input)); return Response.json({ scoped_identity_id: options.keyScope === undefined ? CONFIG.identityId : options.keyScope, status: options.keyStatus ?? "active" }); }
      sends.push({ url: String(input), body: JSON.parse(String(init?.body)), options: init!, disk: JSON.parse(readFileSync(file, "utf8")) });
      if (options.sendThrow) throw new Error(`network ${CONFIG.apiKey} ${CONFIG.signingSecret}`);
      return new Response("{}", { status: options.sendStatus ?? 201 });
    }) as typeof fetch });
  const server: Server = createServer(async (req, res) => { if (!await channel.handle(req, res)) { res.statusCode = 404; res.end(); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { channel.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  return { channel, file, turns, sends, keyChecks, post: (body: unknown, headers?: Record<string, string>) => { const raw = typeof body === "string" ? body : JSON.stringify(body); return fetch(`${url}/inkbox`, { method: "POST", headers: headers ?? signed(raw), body: raw }); }, url };
}

describe("InkboxChannel signed durable HTTP boundary", () => {
  it("loads through the production Node strip-types runtime", () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `await import(${JSON.stringify(new URL("./inkbox-channel.ts", import.meta.url).href)});`], { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
  });
  it("persists before acknowledging, dispatches owner text, and sends one private persisted reply", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const calls: unknown[][] = [];
    const f = await fixture({ onOwner: async (id, text) => { calls.push([id, text]); await held; return "safe reply"; } });
    const response = await f.post(event());
    expect(response.status).toBe(202);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f.file, "utf8")).deliveries[0].id).toBe("evt_one");
    release();
    await f.channel.idle();
    expect(calls).toEqual([["evt_one", "hello"]]);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].url).toBe("https://inkbox.ai/api/v1/imessage/messages");
    expect(f.sends[0].body).toEqual({ to: OWNER, text: "safe reply" });
    expect(f.sends[0].options.redirect).toBe("error");
    expect(f.sends[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(f.sends[0].disk).toMatchObject({ deliveries: [{ status: "sending", reply: "safe reply" }] });
    expect(f.channel.status()).toMatchObject({ configured: true, ownerPhone: OWNER, botId: "bot-fixture", deliveries: [{ status: "sent", reply: "safe reply" }] });
    const disk = readFileSync(f.file, "utf8");
    expect(disk).not.toContain("untrusted history");
    expect(disk).not.toContain("carrier-supplied-untrusted");
  });

  it("uses only the locally bound contact identity for incoming SMS", async () => {
    const f = await fixture();
    expect((await f.post(event("evt_contact", CONTACT, "text"))).status).toBe(202);
    await f.channel.idle();
    expect(f.turns).toEqual([["contact", "contact-fixture", "evt_contact", "hello"]]);
    expect(f.sends[0].url).toBe("https://inkbox.ai/api/v1/phone/numbers/number-fixture/texts");
    expect(f.sends[0].body).toEqual({ to: CONTACT, text: "contact reply" });
  });

  it.each(["admin", "wrong-identity", "inactive"])("refuses %s API keys before dispatch or send", async invalid => {
    const f = await fixture({ keyScope: invalid === "admin" ? null : invalid === "wrong-identity" ? "other-identity" : CONFIG.identityId, keyStatus: invalid === "inactive" ? "revoked" : "active" });
    expect((await f.post(event())).status).toBe(202); await f.channel.idle();
    expect(f.turns).toEqual([]); expect(f.sends).toEqual([]); expect(f.channel.status().deliveries[0].status).toBe("failed");
    expect(f.channel.status().deliveries[0].error).toContain("key");
  });

  it("validates the remote identity-scoped API key once per process", async () => {
    const f = await fixture(); await f.post(event("evt_one")); await f.post(event("evt_two")); await f.channel.idle();
    expect(f.keyChecks).toEqual(["https://inkbox.ai/api/v1/api-keys/self"]); expect(f.turns).toHaveLength(2); expect(f.sends).toHaveLength(2);
  });

  it("deduplicates stable events across requests and restarts and rejects changed replay bodies", async () => {
    const f = await fixture();
    expect((await f.post(event())).status).toBe(202);
    await f.channel.idle();
    expect((await f.post(event())).status).toBe(202);
    await f.channel.idle();
    expect(f.turns).toHaveLength(1);
    expect(f.sends).toHaveLength(1);
    const changed = event(); changed.data.message!.content = "different";
    expect((await f.post(changed)).status).toBe(409);
    f.channel.close();
    const restarted = await fixture({ file: f.file });
    expect((await restarted.post(event())).status).toBe(202);
    await restarted.channel.idle();
    expect(restarted.turns).toEqual([]);
    expect(restarted.sends).toEqual([]);
  });

  it.each(["missing", "wrong", "algorithm", "stale", "milliseconds", "future"])("rejects %s signature before admission", async kind => {
    const f = await fixture(); const raw = JSON.stringify(event()); const headers = signed(raw);
    if (kind === "missing") delete (headers as Partial<typeof headers>)["x-inkbox-signature"];
    if (kind === "wrong") headers["x-inkbox-signature"] = `sha256=${"a".repeat(64)}`;
    if (kind === "algorithm") headers["x-inkbox-signature"] = headers["x-inkbox-signature"].replace("sha256=", "sha1=");
    if (kind === "stale") Object.assign(headers, signed(raw, Math.floor(NOW / 1000) - 301));
    if (kind === "milliseconds") Object.assign(headers, signed(raw, NOW));
    if (kind === "future") Object.assign(headers, signed(raw, Math.floor(NOW / 1000) + 301));
    expect((await f.post(raw, headers)).status).toBe(403);
    await f.channel.idle(); expect(f.turns).toEqual([]); expect(f.channel.status().deliveries).toEqual([]);
  });

  it.each(["group", "participants", "recipient", "companion", "sponsored", "outbound", "unknown", "identity", "ambiguous", "mms"])("rejects %s inbound context", async kind => {
    const f = await fixture(); const payload: any = event("evt_reject", kind === "unknown" ? "+14155550888" : OWNER, kind === "mms" ? "text" : "imessage");
    if (kind === "group") payload.data.message.is_group = true;
    if (kind === "participants") payload.data.message.participants = [OWNER, CONTACT];
    if (kind === "recipient") payload.data.message.recipients = [{ remote_number: OWNER }];
    if (kind === "companion") payload.companion = { phase: "live" };
    if (kind === "sponsored") payload.data.message.sender_access = "sponsored";
    if (kind === "outbound") payload.data.message.direction = "outbound";
    if (kind === "identity") payload.agent_identity_id = "other-identity";
    if (kind === "ambiguous") delete payload.data.message.is_group;
    if (kind === "mms") payload.data.text_message.type = "mms";
    expect((await f.post(payload)).status).toBe(kind === "unknown" || kind === "identity" ? 403 : 400);
    await f.channel.idle(); expect(f.turns).toEqual([]); expect(f.sends).toEqual([]);
  });

  it("accepts official Unix seconds signature with an ISO event timestamp", async () => {
    const f = await fixture();
    expect((await f.post(event())).status).toBe(202);
    await f.channel.idle(); expect(f.turns).toHaveLength(1);
  });

  it("fails closed for malformed or oversized signed JSON and non-received events", async () => {
    const f = await fixture();
    expect((await f.post("{")).status).toBe(400);
    expect((await f.post("x".repeat(140_000))).status).toBe(413);
    expect((await f.post({ ...event(), event_type: "imessage.sent" })).status).toBe(400);
    expect((await fetch(`${f.url}/inkbox`)).status).toBe(404);
  });

  it("refuses admission before acknowledgment when the atomic inbox write fails", async () => {
    const f = await fixture(); mkdirSync(f.file);
    expect((await f.post(event())).status).toBe(503);
    await f.channel.idle(); expect(f.turns).toEqual([]); expect(f.sends).toEqual([]); expect(f.channel.status().deliveries).toEqual([]);
  });

  it("checks signature freshness again after a slow request body arrives", async () => {
    const f = await fixture(); const raw = JSON.stringify(event());
    // Start within the window; advance the injected clock while collecting the body.
    let current = NOW;
    const dir = mkdtempSync(join(tmpdir(), "omb-inkbox-clock-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const channel = new InkboxChannel({ file: join(dir, "inbox.json"), config: CONFIG, now: () => current, contactForPhone: () => null, onOwner: async () => "reply", onContact: async () => "reply" });
    const { PassThrough } = await import("node:stream");
    const req = new PassThrough() as unknown as import("node:http").IncomingMessage;
    req.method = "POST"; req.url = "/inkbox"; req.headers = signed(raw, Math.floor(NOW / 1000) - 299); req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, String(value)]);
    let status = 0;
    const res = { set statusCode(value: number) { status = value; }, setHeader() {}, end() {} } as unknown as import("node:http").ServerResponse;
    const processing = channel.handle(req, res); current += 2000; (req as unknown as import("node:stream").PassThrough).end(raw);
    await processing; channel.close(); expect(status).toBe(403); expect(channel.status().deliveries).toEqual([]); expect(f.turns).toEqual([]);
  });

  it("retains an unsent reply when stopped during host processing", async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let begin!: () => void; const started = new Promise<void>(resolve => { begin = resolve; });
    const f = await fixture({ onOwner: async () => { begin(); await held; return "retained reply"; } });
    await f.post(event()); await started; f.channel.close(); release(); await f.channel.idle();
    expect(f.sends).toEqual([]);
    expect(f.channel.status().deliveries[0].status).toBe("uncertain");
    expect(JSON.parse(readFileSync(f.file, "utf8")).deliveries[0].reply).toBe("retained reply");
  });

  it("refuses outbound delivery when contact binding changes during processing", async () => {
    let approved = true; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const dir = mkdtempSync(join(tmpdir(), "omb-inkbox-revoke-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const sends: string[] = [];
    const channel = new InkboxChannel({ file: join(dir, "inbox.json"), config: CONFIG, now: () => NOW, contactForPhone: () => approved ? "contact-fixture" : null,
      onOwner: async () => "reply", onContact: async () => { await held; return "private reply"; }, fetch: (async (input: string | URL | Request, init?: RequestInit) => { if (init?.method === "GET") return Response.json({ scoped_identity_id: CONFIG.identityId, status: "active" }); sends.push(String(input)); return new Response("{}"); }) as typeof fetch });
    const { PassThrough } = await import("node:stream"); const raw = JSON.stringify(event("evt_contact", CONTACT));
    const req = new PassThrough() as unknown as import("node:http").IncomingMessage; req.method = "POST"; req.url = "/inkbox"; req.headers = signed(raw); req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, String(value)]);
    const res = { statusCode: 0, setHeader() {}, end() {} } as unknown as import("node:http").ServerResponse;
    const processing = channel.handle(req, res); (req as unknown as import("node:stream").PassThrough).end(raw); await processing;
    await new Promise(resolve => setImmediate(resolve)); approved = false; release(); await channel.idle(); channel.close();
    expect(sends).toEqual([]); expect(channel.status().deliveries[0]).toMatchObject({ status: "failed", reply: "private reply" });
  });

  it("never sends when reply persistence fails after host processing", async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ onOwner: async () => { await held; return "unsent reply"; } }); await f.post(event());
    await new Promise(resolve => setImmediate(resolve)); rmSync(f.file); mkdirSync(f.file); release(); await f.channel.idle();
    expect(f.sends).toEqual([]); expect(f.channel.status().deliveries[0]).toMatchObject({ status: "uncertain", reply: "unsent reply" });
    expect((await f.post(event("evt_next"))).status).toBe(503);
  });

  it("treats server failure as uncertain and does not retry a possibly accepted send", async () => {
    const f = await fixture({ sendStatus: 500 }); await f.post(event()); await f.channel.idle();
    expect(f.channel.status().deliveries[0]).toMatchObject({ status: "uncertain", reply: "owner reply" });
    await f.post(event()); await f.channel.idle(); expect(f.sends).toHaveLength(1);
  });

  it.each(["pending", "processing", "sending"])("quarantines %s rows on restart without replay", async state => {
    const f = await fixture(); await f.post(event()); await f.channel.idle(); f.channel.close();
    const ledger = JSON.parse(readFileSync(f.file, "utf8")); ledger.deliveries[0].status = state; writeFileSync(f.file, JSON.stringify(ledger));
    const restarted = await fixture({ file: f.file }); await restarted.channel.idle();
    expect(restarted.channel.status().deliveries[0].status).toBe("uncertain");
    expect(JSON.parse(readFileSync(f.file, "utf8")).deliveries[0].status).toBe("uncertain");
    expect((await restarted.post(event())).status).toBe(202);
    await restarted.channel.idle(); expect(restarted.turns).toEqual([]); expect(restarted.sends).toEqual([]);
  });

  it("preserves the channel binding when disabled during restart recovery", async () => {
    const f = await fixture(); await f.post(event()); await f.channel.idle(); f.channel.close();
    const ledger = JSON.parse(readFileSync(f.file, "utf8")); ledger.deliveries[0].status = "sending"; writeFileSync(f.file, JSON.stringify(ledger));
    const disabled = await fixture({ file: f.file, config: false }); expect(disabled.channel.status().configured).toBe(false); disabled.channel.close();
    const enabled = await fixture({ file: f.file }); expect(enabled.channel.status().deliveries[0].status).toBe("uncertain");
    await enabled.channel.idle(); expect(enabled.turns).toEqual([]); expect(enabled.sends).toEqual([]);
  });

  it.each(["http", "network"])("keeps the full reply and exposes %s send failure without secrets", async failure => {
    const f = await fixture({ sendStatus: failure === "http" ? 403 : 201, sendThrow: failure === "network" });
    await f.post(event()); await f.channel.idle();
    expect(f.channel.status().deliveries[0]).toMatchObject({ status: failure === "network" ? "uncertain" : "failed", reply: "owner reply" });
    expect(f.channel.status().deliveries[0].error).toBeTruthy();
    const status = JSON.stringify(f.channel.status()); expect(status).not.toContain(CONFIG.apiKey); expect(status).not.toContain(CONFIG.signingSecret);
    expect((await f.post(event())).status).toBe(202); await f.channel.idle(); expect(f.sends).toHaveLength(1);
  });

  it("sends one bounded SMS reply with a clear truncation notice and retains the full reply", async () => {
    const reply = "🙂".repeat(2000); const f = await fixture({ reply }); await f.post(event("evt_long", OWNER, "text")); await f.channel.idle();
    const sent = f.sends[0].body as { text: string }; expect([...sent.text].length).toBeLessThanOrEqual(1600); expect(sent.text).toContain("truncated");
    expect(JSON.parse(readFileSync(f.file, "utf8")).deliveries[0].reply).toBe(reply); expect(f.sends).toHaveLength(1);
  });

  it("limits a sender to 30 new events per hour but still acknowledges duplicates", async () => {
    const f = await fixture();
    await f.channel.notifyOwner("notice_rate", "A delayed result", "imessage");
    for (let n = 0; n < 30; n++) expect((await f.post(event(`evt_${n}`))).status).toBe(202);
    expect((await f.post(event("evt_extra"))).status).toBe(429);
    expect((await f.post(event("evt_0"))).status).toBe(202);
    await f.channel.idle(); expect(f.turns).toHaveLength(30);
  });

  it("refuses the 1001st row rather than evicting durable events", async () => {
    const f = await fixture(); await f.post(event()); await f.channel.idle(); f.channel.close();
    const ledger = JSON.parse(readFileSync(f.file, "utf8")); ledger.deliveries = Array.from({ length: 1000 }, (_, n) => ({ ...ledger.deliveries[0], id: `evt_old_${n}`, receivedAt: NOW - 3_600_001 })); writeFileSync(f.file, JSON.stringify(ledger));
    const restarted = await fixture({ file: f.file }); expect((await restarted.post(event("evt_new"))).status).toBe(503); expect(restarted.channel.status().deliveries).toHaveLength(1000);
  });

  it("keeps incomplete config disabled and reads only dedicated env settings", async () => {
    expect(readInkboxConfig({ OMB_INKBOX_API_KEY: "partial" })).toBeUndefined();
    expect(readInkboxConfig({ OMB_INKBOX_API_KEY: CONFIG.apiKey, OMB_INKBOX_SIGNING_SECRET: CONFIG.signingSecret, OMB_INKBOX_IDENTITY_ID: CONFIG.identityId, OMB_INKBOX_OWNER_PHONE: OWNER, OMB_INKBOX_BOT_ID: CONFIG.botId, OMB_INKBOX_PHONE_NUMBER_ID: CONFIG.phoneNumberId })).toEqual(CONFIG);
    const f = await fixture({ config: false }); expect(f.channel.status()).toEqual({ configured: false, approvalMode: "ask", deliveries: [] }); expect((await f.post(event())).status).toBe(503);
  });
});
it("delivers an internal follow-up once without creating another owner task",async()=>{
 const f=await fixture();await f.channel.notifyOwner("notice_one","Which city?","imessage");
 expect(f.turns).toEqual([]);expect(f.sends).toHaveLength(1);expect(f.sends[0]?.body).toEqual({to:OWNER,text:"Which city?"});
 await f.channel.notifyOwner("notice_one","Which city?","imessage");expect(f.sends).toHaveLength(1);
 await expect(f.channel.notifyOwner("notice_one","Changed question","imessage")).rejects.toThrow();
});
it("does not retry uncertain follow-ups and refuses over-limit or stopped notices",async()=>{
 const f=await fixture({sendThrow:true});await expect(f.channel.notifyOwner("notice_unknown","question","imessage")).rejects.toThrow();
 await expect(f.channel.notifyOwner("notice_unknown","question","imessage")).rejects.toThrow();expect(f.sends).toHaveLength(1);
 await expect(f.channel.notifyOwner("too_long","a".repeat(1601),"text")).rejects.toThrow();expect(f.sends).toHaveLength(1);
 f.channel.close();await expect(f.channel.notifyOwner("stopped","question","imessage")).rejects.toThrow();
});
it("drops a queued follow-up superseded by an earlier owner command", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let current = true;
  const f = await fixture({ onOwner: async () => { await held; current = false; return "New task question"; } });
  await f.post(event());
  const notice = f.channel.notifyOwner("notice_stale", "Old task question", "imessage", () => current);
  const rejected = expect(notice).rejects.toThrow();
  release();
  await rejected;
  expect(f.sends.map(send => send.body)).toEqual([{ to: OWNER, text: "New task question" }]);
});

it("durably records mail, Slack, call and agent inputs without granting owner authority", async () => {
 const f=await fixture({config:{...CONFIG,mailboxId:"mailbox-fixture",emailAddress:"agent@example.test"}});
 const cases=[
  {event_type:"message.received",data:{message:{id:"mail-one",mailbox_id:"mailbox-fixture",email_address:"agent@example.test",from_address:"owner@example.test",direction:"inbound",body:"APPROVE dangerous",body_state:"complete"}}},
  {event_type:"slack.dm_received",data:{identity_id:CONFIG.identityId,connection_id:"connection-one",workspace_id:"T123",actor_id:"U123",conversation_id:"D123",event:{text:"APPROVE dangerous"}}},
  {event_type:"call.ended",data:{call:{id:"call-one",remote_phone_number:OWNER},outcome:"completed",transcript:{entries:[{party:"remote",text:"APPROVE dangerous"}]}}},
  {event_type:"a2a.task.created",data:{task_id:"task-one",caller:{identity_id:"remote-agent",handle:"remote"},parts:[{text:"APPROVE dangerous"}]}}
 ];
 for (const [i,item] of cases.entries()) expect((await f.post({id:`evt_record_${i}`,timestamp:new Date(NOW).toISOString(),...item})).status).toBe(202);
 await f.channel.idle();expect(f.turns).toEqual([]);expect(f.sends).toEqual([]);
 expect(f.channel.status().deliveries.map(d=>d.status)).toEqual(["recorded","recorded","recorded","recorded"]);
 expect(f.channel.status().deliveries.map(d=>d.channel)).toEqual(["email","slack","calls","a2a"]);
 f.channel.close();const restored=await fixture({file:f.file,config:{...CONFIG,mailboxId:"mailbox-fixture",emailAddress:"agent@example.test"}});
 expect(restored.channel.status().deliveries).toHaveLength(4);expect(restored.turns).toEqual([]);
});
it("rejects signed mail for another mailbox and Slack for another identity",async()=>{
 const f=await fixture({config:{...CONFIG,mailboxId:"mailbox-fixture",emailAddress:"agent@example.test"}});
 for (const payload of [
  {event_type:"message.received",data:{message:{mailbox_id:"wrong",email_address:"agent@example.test",from_address:"owner@example.test",direction:"inbound",body:"hello"}}},
  {event_type:"slack.dm_received",data:{identity_id:"wrong",workspace_id:"T123",actor_id:"U123",event:{text:"hello"}}}
 ])expect((await f.post({id:"evt_wrong",timestamp:new Date(NOW).toISOString(),...payload})).status).toBe(403);
 expect(f.channel.status().deliveries).toEqual([]);
});
it("migrates an iMessage-only inbox when its same identity gains an owned phone",async()=>{
 const f=await fixture({config:{...CONFIG,phoneNumberId:undefined}});await f.post(event());await f.channel.idle();f.channel.close();
 const restored=await fixture({file:f.file,config:CONFIG});
 expect(restored.channel.status().deliveries).toHaveLength(1);
 await restored.post(event());await restored.channel.idle();expect(restored.turns).toEqual([]);
});
it("preserves the provider conversation for a validated iMessage reply and sends bounded typing feedback",async()=>{
 const f=await fixture();const payload=event();payload.data.message!.conversation_id="a1111111-1111-4111-8111-111111111111";
 expect((await f.post(payload)).status).toBe(202);await f.channel.idle();
 const send=f.sends.find(s=>s.url.endsWith("/messages"));
 expect(send?.body).toMatchObject({conversation_id:"a1111111-1111-4111-8111-111111111111",text:"owner reply"});
 expect(f.sends.filter(s=>s.url.endsWith("/typing"))).toHaveLength(1);
});
it("records MMS without fetching media or granting a group sender owner authority",async()=>{
 const f=await fixture({config:{...CONFIG,phoneNumber:"+14155550000"}});
 const payload:any=event("evt_mms",OWNER,"text");payload.data.text_message.type="mms";
 payload.data.text_message.text="Please approve this image";payload.data.text_message.media=[{url:"https://untrusted.example/image.jpg"}];
 payload.data.text_message.participants=[OWNER,CONTACT];
 expect((await f.post(payload)).status).toBe(202);await f.channel.idle();
 expect(f.turns).toEqual([]);expect(f.sends).toEqual([]);expect(f.keyChecks).toEqual([]);
 expect(f.channel.status().deliveries).toEqual([expect.objectContaining({channel:"text",status:"recorded",text:expect.stringContaining("Please approve this image")})]);
 expect(readFileSync(f.file,"utf8")).not.toContain("https://untrusted.example");
 payload.id="evt_other_number";payload.data.text_message.local_phone_number="+14155559999";
 expect((await f.post(payload)).status).toBe(403);
});

it("retains only recent passive observations so 1000 observations cannot block owner chat or follow-ups",async()=>{
 const f=await fixture({config:{...CONFIG,mailboxId:"mailbox-fixture",emailAddress:"agent@example.test"}});
 const mail={id:"evt_passive",timestamp:new Date(NOW).toISOString(),event_type:"message.received",data:{message:{id:"mail-one",mailbox_id:"mailbox-fixture",email_address:"agent@example.test",from_address:"observer@example.test",direction:"inbound",body:"observation",body_state:"complete"}}};
 await f.post(mail);await f.channel.idle();f.channel.close();
 const ledger=JSON.parse(readFileSync(f.file,"utf8"));
 ledger.deliveries=Array.from({length:1000},(_,n)=>({...ledger.deliveries[0],id:`evt_passive_${n}`,sender:OWNER,receivedAt:NOW+n}));
 writeFileSync(f.file,JSON.stringify(ledger));
 const restored=await fixture({file:f.file,config:{...CONFIG,mailboxId:"mailbox-fixture",emailAddress:"agent@example.test"}});
 expect((await restored.post(event("evt_owner_after_observations"))).status).toBe(202);await restored.channel.idle();
 await restored.channel.notifyOwner("notice_after_observations","Result","imessage");
 expect(restored.turns).toHaveLength(1);expect(restored.sends).toHaveLength(2);
 const rows=JSON.parse(readFileSync(f.file,"utf8")).deliveries;
 expect(rows.filter((row:any)=>row.route==="record")).toHaveLength(500);
 expect(rows.some((row:any)=>row.id==="evt_passive_999")).toBe(true);
 expect(rows.some((row:any)=>row.id==="evt_passive_0")).toBe(false);
});
it("evicts only passive records while preserving 1000 durable action receipts",async()=>{
 const f=await fixture({config:{...CONFIG,mailboxId:"mailbox-fixture",emailAddress:"agent@example.test"}});
 await f.post(event());await f.channel.idle();f.channel.close();
 const ledger=JSON.parse(readFileSync(f.file,"utf8"));
 const receipt=ledger.deliveries[0];
 ledger.deliveries=[...Array.from({length:1000},(_,n)=>({...receipt,id:`evt_receipt_${n}`,receivedAt:NOW-3_600_001})),...Array.from({length:500},(_,n)=>({...receipt,id:`evt_observation_${n}`,route:"record",status:"recorded",channel:"email",sender:"a@example.test",receivedAt:NOW-3_600_001}))];
 writeFileSync(f.file,JSON.stringify(ledger));
 const restored=await fixture({file:f.file,config:{...CONFIG,mailboxId:"mailbox-fixture",emailAddress:"agent@example.test"}});
 const mail={id:"evt_new_passive",timestamp:new Date(NOW).toISOString(),event_type:"message.received",data:{message:{id:"mail-one",mailbox_id:"mailbox-fixture",email_address:"agent@example.test",from_address:"observer@example.test",direction:"inbound",body:"observation",body_state:"complete"}}};
 expect((await restored.post(mail)).status).toBe(202);
 expect((await restored.post(event("evt_action_over_limit"))).status).toBe(503);
 await expect(restored.channel.notifyOwner("notice_over_limit","Result","imessage")).rejects.toThrow();
 const rows=JSON.parse(readFileSync(f.file,"utf8")).deliveries;
 expect(rows.filter((row:any)=>row.route!=="record").map((row:any)=>row.id)).toEqual(Array.from({length:1000},(_,n)=>`evt_receipt_${n}`));
 expect(rows.filter((row:any)=>row.route==="record")).toHaveLength(500);
});
it.each([
 {name:"complete",body:"Whole message",body_state:"complete",body_truncated:false,want:"complete"},
 {name:"provider truncated",body:"Prefix",body_state:"truncated",body_truncated:true,want:"truncated"},
 {name:"unavailable",body:null,body_state:"unavailable",body_truncated:false,want:"unavailable"},
 {name:"locally truncated",body:"x".repeat(4100),body_state:"complete",body_truncated:false,want:"truncated"},
])("preserves exact email references and marks $name previews",async({body,body_state,body_truncated,want})=>{
 const config={...CONFIG,mailboxId:"mailbox-fixture",emailAddress:"agent@example.test"};const f=await fixture({config});
 const payload={id:"evt_preview",timestamp:new Date(NOW).toISOString(),event_type:"message.received",data:{message:{id:"mail-one",mailbox_id:"mailbox-fixture",email_address:"agent@example.test",thread_id:"thread-one",message_id:"<rfc@example.test>",from_address:"sender@example.test",direction:"inbound",body,body_state,body_truncated}}};
 expect((await f.post(payload)).status).toBe(202);
 const row=f.channel.status().deliveries[0];
 expect(row).toMatchObject({previewState:want,reference:{channel:"email",messageId:"mail-one",mailboxId:"mailbox-fixture",emailAddress:"agent@example.test",threadId:"thread-one",rfcMessageId:"<rfc@example.test>"}});
 if(want!=="complete")expect(row.previewNotice).toBeTruthy();
 expect(row.text!.length).toBeLessThanOrEqual(4000);
 f.channel.close();const restored=await fixture({file:f.file,config});expect(restored.channel.status().deliveries[0]).toEqual(row);
});
it("marks abridged call previews and preserves call, Slack and agent lookup coordinates",async()=>{
 const f=await fixture();const timestamp=new Date(NOW).toISOString();
 for (const payload of [
  {id:"evt_call_ref",timestamp,event_type:"call.ended",data:{call:{id:"call-one",remote_phone_number:OWNER},transcript:{abridged:true,entries:[{party:"remote",text:"First"},{marker:"abridged",omitted_turns:12},{party:"remote",text:"Last"}]}}},
  {id:"evt_slack_ref",timestamp,event_type:"slack.dm_received",data:{identity_id:CONFIG.identityId,connection_id:"connection-one",workspace_id:"T123",actor_id:"U123",conversation_id:"D123",message_ts:"1234.5678",thread_ts:"1234.0001",event:{text:"Reply"}}},
  {id:"evt_a2a_ref",timestamp,event_type:"a2a.task.message",data:{task_id:"task-one",context_id:"context-one",message_id:"message-one",caller:{identity_id:"remote-agent"},parts:[{text:"Reply"}]}}
 ])expect((await f.post(payload)).status).toBe(202);
 const rows=f.channel.status().deliveries;
 expect(rows[0]).toMatchObject({previewState:"truncated",previewNotice:expect.stringContaining("abridged"),reference:{channel:"calls",callId:"call-one"}});
 expect(rows[1]).toMatchObject({reference:{channel:"slack",connectionId:"connection-one",workspaceId:"T123",conversationId:"D123",messageTs:"1234.5678",threadTs:"1234.0001"}});
 expect(rows[2]).toMatchObject({reference:{channel:"a2a",taskId:"task-one",contextId:"context-one",messageId:"message-one"}});
 expect(f.turns).toEqual([]);expect(f.sends).toEqual([]);
});

it.each([OWNER, CONTACT])("acknowledges signed iMessage attachments from %s without treating YES as approval", async sender => {
  let approvals = 0;
  const f = await fixture({ onOwner: async (_id, text) => { if (text.toLowerCase() === "yes") approvals++; return "Approved"; },
    onContact: async () => { approvals++; return "Approved"; } });
  const payload: any = event("evt_attachment_yes", sender);
  payload.data.message.content = "yes";
  payload.data.message.media = [{ url: "https://untrusted.example/private.jpg", mime_type: "image/jpeg" }];
  expect((await f.post(payload)).status).toBe(202);
  await f.channel.idle();
  expect(approvals).toBe(0);
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0].body).toMatchObject({ to: sender, text: expect.stringContaining("cannot read attachments") });
  expect(f.sends[0].body).toMatchObject({ text: expect.stringContaining("was not processed") });
  const row = JSON.parse(readFileSync(f.file, "utf8")).deliveries[0];
  expect(row).toMatchObject({ unsupportedAttachment: true, status: "sent", eventTimestamp: NOW });
  expect(readFileSync(f.file, "utf8")).not.toContain("https://untrusted.example");
  f.channel.close();
  const restarted = await fixture({ file: f.file });
  expect((await restarted.post(payload)).status).toBe(202);
  await restarted.channel.idle();
  expect(restarted.turns).toEqual([]);
  expect(restarted.sends).toEqual([]);
  expect(JSON.parse(readFileSync(f.file, "utf8")).deliveries[0].unsupportedAttachment).toBe(true);
});

it("accepts media-only iMessage while retaining sender and group checks", async () => {
  const f = await fixture();
  const payload: any = event("evt_media_only");
  delete payload.data.message.content;
  payload.data.message.media = [{ url: "https://untrusted.example/file" }];
  expect((await f.post(payload)).status).toBe(202);
  await f.channel.idle();
  expect(f.turns).toEqual([]);
  expect(f.sends[0].body).toMatchObject({ text: expect.stringContaining("cannot read attachments") });
  payload.id = "evt_media_group"; payload.data.message.is_group = true;
  expect((await f.post(payload)).status).toBe(400);
  payload.id = "evt_media_unknown"; payload.data.message.is_group = false; payload.data.message.remote_number = "+14155550888";
  expect((await f.post(payload)).status).toBe(403);
});


it("passes signed event time and receipt time to owner dispatch and persists them", async () => {
  let metadata: unknown;
  const f = await fixture({ onOwner: async (_id, _text, _channel, value) => { metadata = value; return "Received"; } });
  const payload = event("evt_timing");
  payload.timestamp = new Date(NOW - 12_000).toISOString();
  expect((await f.post(payload)).status).toBe(202);
  await f.channel.idle();
  expect(metadata).toEqual({ receivedAt: NOW, eventTimestamp: NOW - 12_000 });
  const stored = JSON.parse(readFileSync(f.file, "utf8"));
  expect(stored.deliveries[0]).toMatchObject({ receivedAt: NOW, eventTimestamp: NOW - 12_000 });
  f.channel.close();
  // Receipts written by earlier releases remain readable without inventing a
  // signed event timestamp they did not preserve.
  delete stored.deliveries[0].eventTimestamp;
  writeFileSync(f.file, JSON.stringify(stored));
  const restored = await fixture({ file: f.file });
  expect(restored.channel.status().deliveries[0].status).toBe("sent");
});

it("reads the current approval preference on each status snapshot", async () => {
  let mode: "ask" | "auto" = "ask";
  const f = await fixture({ approvalMode: () => mode });
  expect(f.channel.status().approvalMode).toBe("ask");
  mode = "auto";
  expect(f.channel.status().approvalMode).toBe("auto");
});


it("revokes at authenticated owner receipt while earlier dispatch is stalled, before publishing the receipt", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const dispatched: string[] = [];
  let automatic = true;
  const receipts: unknown[] = [];
  const f = await fixture({ onOwner: async (_id, text) => { dispatched.push(text); if (text === "hello") await held; return "Done"; },
    onOwnerReceived: (text, metadata) => {
      receipts.push({ text, metadata });
      if (text === "ask me first") {
        // The safety restriction must be saved before a crash could leave the
        // transport with a durable receipt that will never be dispatched again.
        expect(JSON.parse(readFileSync(f.file, "utf8")).deliveries.some((row: any) => row.id === "evt_revoke")).toBe(false);
        automatic = false;
      }
    } });
  try {
    await f.post(event("evt_held"));
    await new Promise(resolve => setImmediate(resolve));
    const revoke = event("evt_revoke"); revoke.data.message!.content = "ask me first";
    expect((await f.post(revoke)).status).toBe(202);
    expect(dispatched).toEqual(["hello"]);
    expect(automatic).toBe(false);
    expect(receipts).toEqual([
      { text: "hello", metadata: { receivedAt: NOW, eventTimestamp: NOW } },
      { text: "ask me first", metadata: { receivedAt: NOW, eventTimestamp: NOW } },
    ]);
    expect((await f.post(revoke)).status).toBe(202);
    expect(receipts).toHaveLength(2);
  } finally { release(); await f.channel.idle(); }
});

it("never invokes immediate owner revocation for unsigned, contact, or attachment events", async () => {
  const receipts: string[] = [];
  const f = await fixture({ onOwnerReceived: text => { receipts.push(text); } });
  const owner = event("evt_unsigned_revoke"); owner.data.message!.content = "ask me first";
  const raw = JSON.stringify(owner);
  expect((await f.post(owner, { ...signed(raw), "x-inkbox-signature": `sha256=${"0".repeat(64)}` })).status).toBe(403);
  const contact = event("evt_contact_revoke", CONTACT); contact.data.message!.content = "ask me first";
  expect((await f.post(contact)).status).toBe(202);
  const attachment: any = event("evt_attachment_revoke"); attachment.data.message.content = "ask me first";
  attachment.data.message.media = [{ url: "https://untrusted.example/media" }];
  expect((await f.post(attachment)).status).toBe(202);
  await f.channel.idle();
  expect(receipts).toEqual([]);
});

it("does not acknowledge or publish an owner receipt when its immediate safety persistence fails", async () => {
  const f = await fixture({ onOwnerReceived: () => { throw new Error("Fixture safety store failed"); } });
  expect((await f.post(event())).status).toBe(503);
  expect(f.channel.status().deliveries).toEqual([]);
  expect(f.turns).toEqual([]);
  expect(f.sends).toEqual([]);
});


it("keeps a real failed revocation unacknowledged until restart can durably save Ask", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-inkbox-revocation-state-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "conversation.json");
  const previous = JSON.stringify({ version: 1, binding: "fixture-owner", approvalMode: "auto" });
  writeFileSync(stateFile, previous);
  let dispatches = 0;
  const makeConversation = () => new ChannelConversation({ file: stateFile, binding: "fixture-owner", now: () => NOW,
    createAskTask: () => { throw new Error("No new task is permitted"); },
    send: async () => { throw new Error("No task dispatch is permitted"); },
    respond: async () => { throw new Error("No approval is permitted"); },
    snapshot: () => { throw new Error("No task observation is expected"); },
  });
  let conversation = makeConversation();
  expect(conversation.approvalMode).toBe("auto");
  const f = await fixture({
    onOwnerReceived: (text, metadata) => conversation.revokeAutomaticForOwnerMessage(text, metadata),
    onOwner: async (id, text, channel, metadata) => {
      dispatches++;
      return conversation.handle(id, text, { channel, maxReplyCharacters: 18000, ...metadata });
    },
  });
  // An unreadable target reproduces the real atomic-save failure without any
  // user credentials, filesystem permissions, or application data involved.
  rmSync(stateFile); mkdirSync(stateFile);
  const revoke = event("evt_real_revoke"); revoke.data.message!.content = "ask me first";
  expect((await f.post(revoke)).status).toBe(503);
  expect((await f.post(revoke)).status).toBe(503);
  expect(f.channel.status().deliveries).toEqual([]);
  expect(dispatches).toBe(0);
  expect(f.sends).toEqual([]);
  expect(conversation.approvalMode).toBe("ask");
  // Recovery requires a fresh conversation. Its old durable preference is
  // still Auto, so retrying the same unacknowledged event must really save Ask.
  rmSync(stateFile, { recursive: true }); writeFileSync(stateFile, previous);
  conversation = makeConversation();
  expect(conversation.approvalMode).toBe("auto");
  expect((await f.post(revoke)).status).toBe(202);
  await f.channel.idle();
  expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ approvalMode: "ask", approvalControlAt: NOW });
  expect(makeConversation().approvalMode).toBe("ask");
  expect(dispatches).toBe(1);
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0].body).toMatchObject({ text: expect.stringContaining("Ask first") });
});

it.each([30, 1000])("revokes automatic authority even when %s existing receipts prevent command admission", async count => {
  const f = await fixture();
  await f.post(event()); await f.channel.idle(); f.channel.close();
  const ledger = JSON.parse(readFileSync(f.file, "utf8"));
  ledger.deliveries = Array.from({ length: count }, (_, n) => ({ ...ledger.deliveries[0], id: `evt_limit_${n}` }));
  writeFileSync(f.file, JSON.stringify(ledger));
  const receipts: string[] = [];
  const full = await fixture({ file: f.file, onOwnerReceived: text => { if (text === "ask me first") receipts.push(text); } });
  const revoke = event("evt_revoke_at_limit"); revoke.data.message!.content = "ask me first";
  expect((await full.post(revoke)).status).toBe(count === 30 ? 429 : 503);
  expect(receipts).toEqual(["ask me first"]);
  expect(full.channel.status().deliveries).toHaveLength(count);
  expect(full.turns).toEqual([]); expect(full.sends).toEqual([]);
});
