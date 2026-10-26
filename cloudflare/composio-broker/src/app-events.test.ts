import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enqueue, MAX_WEBHOOK_BODY, runHourly, WAKE_EVERY_MS } from "./app-events";
import { DAY_MS, QUEUE_MAX_BYTES } from "./common";
import {
  brokerHarness,
  CLOUD_GRANT_SECRET,
  cloudGrant,
  composioSignature,
  GMAIL_TYPE,
  message,
  STATS_TOKEN,
  streamedBody,
  WEBHOOK_SECRET,
  type Installation,
} from "./test-harness";
import { forgetTriggerTypes } from "./triggers";

let h: ReturnType<typeof brokerHarness>;

beforeEach(() => {
  forgetTriggerTypes();
  h = brokerHarness();
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An installation with one Gmail account and one trigger on it. */
async function withTrigger(config: Record<string, unknown> = { query: "subject:order" }) {
  const owner = await h.install();
  const accountId = h.account(owner);
  const { response, body } = await h.createTrigger(owner, accountId, config);
  expect(response.status).toBe(201);
  return { owner, accountId, triggerId: body.triggerId };
}

async function asCloud(owner: Installation, machineId = `machine-${owner.id.slice(0, 8)}`) {
  const response = await h.call(owner, "/v1/installation/cloud", { method: "PUT", body: JSON.stringify({ grant: cloudGrant(machineId) }) });
  expect(response.status).toBe(200);
}

function fill(owner: Installation, triggerId: string, count: number, body = "{}", now = Date.now()) {
  const row = { id: owner.id, composio_user_id: owner.userId, cloud_machine_id: h.d1.rows<{ cloud_machine_id: string | null }>(
    "SELECT cloud_machine_id FROM installations WHERE id = ?", owner.id)[0].cloud_machine_id };
  return (async () => {
    const results = [];
    for (let index = 0; index < count; index += 1) {
      results.push(await enqueue(h.env as never, row, { eventId: `fill_${crypto.randomUUID()}`, kind: "message", triggerId, body }, now));
    }
    return results;
  })();
}

/** Lets real async work (WebCrypto) run until the poll has read the queue `times` times, so fake timers start
 *  counting only once it is holding. */
async function untilPollReads(times: number) {
  const reads = () => h.d1.sqlLog.filter((sql) => sql.includes("acked_at IS NULL AND seq > ?")).length;
  for (let turn = 0; reads() < times; turn += 1) {
    if (turn > 1000) throw new Error("the poll never read the queue");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function pollBody(owner: Installation, query = "", poller?: string) {
  const response = await h.poll(owner, query, poller);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ events: Array<{ seq: number; id: string; kind: string; triggerId: string | null; receivedAt: number; event: Record<string, any> }>; cursor: number }>;
}

describe("Composio webhook signature", () => {
  it("queues a delivery signed with the webhook secret", async () => {
    const { owner, triggerId } = await withTrigger();
    const response = await h.deliver(message(triggerId, owner.userId));
    expect(response.status).toBe(200);
    expect(h.queued(owner.id)).toHaveLength(1);
  });

  it("refuses a delivery signed with another secret and queues nothing", async () => {
    const { owner, triggerId } = await withTrigger();
    const response = await h.deliver(message(triggerId, owner.userId), { secret: "whsec_someone_else" });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid signature" });
    expect(h.queued()).toEqual([]);
  });

  it("refuses a timestamp more than 300 s old or ahead, so a captured delivery cannot be replayed later", async () => {
    const { owner, triggerId } = await withTrigger();
    const now = Math.floor(Date.now() / 1000);
    expect((await h.deliver(message(triggerId, owner.userId), { timestamp: now - 301 })).status).toBe(401);
    expect((await h.deliver(message(triggerId, owner.userId), { timestamp: now + 301 })).status).toBe(401);
    expect(h.queued()).toEqual([]);
    expect((await h.deliver(message(triggerId, owner.userId), { timestamp: now - 290 })).status).toBe(200);
    expect(h.queued(owner.id)).toHaveLength(1);
  });

  it("accepts a header with several signatures when one of them is valid", async () => {
    const { owner, triggerId } = await withTrigger();
    const wrong = `v1,${composioSignature("whsec_old_secret", "msg_x", 1, "{}")}`;
    const response = await h.deliver(message(triggerId, owner.userId), { signature: (good) => `${wrong} v2,abc ${good}` });
    expect(response.status).toBe(200);
    expect(h.queued(owner.id)).toHaveLength(1);
  });

  it("refuses a signature without its v1, prefix", async () => {
    const { owner, triggerId } = await withTrigger();
    expect((await h.deliver(message(triggerId, owner.userId), { signature: (good) => good.slice(3) })).status).toBe(401);
    expect((await h.deliver(message(triggerId, owner.userId), { signature: (good) => `v2,${good.slice(3)}` })).status).toBe(401);
    expect(h.queued()).toEqual([]);
  });

  it("refuses a body changed after signing", async () => {
    const { owner, triggerId } = await withTrigger();
    const response = await h.deliver(message(triggerId, owner.userId), { tamper: (body) => body.replace("1042", "9999") });
    expect(response.status).toBe(401);
    expect(h.queued()).toEqual([]);
  });

  it("refuses an envelope whose id is not the signed webhook-id", async () => {
    const { owner, triggerId } = await withTrigger();
    const response = await h.deliver(message(triggerId, owner.userId), { id: "msg_signed", envelopeId: "msg_other" });
    expect(response.status).toBe(400);
    expect(h.queued()).toEqual([]);
  });

  it("refuses a delivery without the signature headers", async () => {
    await withTrigger();
    const response = await h.fetch("/v1/composio/webhook", { method: "POST", body: JSON.stringify(message("ti_1", undefined, {}, "msg_1")) });
    expect(response.status).toBe(401);
  });

  it("reads none of a streamed delivery without the signature headers", async () => {
    const stream = streamedBody(64 * 1024, 64);
    const response = await h.fetch("/v1/composio/webhook", stream.init);
    expect(response.status).toBe(401);
    expect(stream.read.bytes).toBe(0);
  });

  it("stops reading a streamed delivery without a Content-Length once it passes 1 MB", async () => {
    const stream = streamedBody(64 * 1024, 64);
    const headers = { "webhook-id": "msg_big", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" };
    const response = await h.fetch("/v1/composio/webhook", { ...stream.init, headers });
    expect(response.status).toBe(413);
    expect(stream.read.cancelled).toBe(true);
    expect(stream.read.bytes).toBeLessThanOrEqual(MAX_WEBHOOK_BODY + 2 * 64 * 1024);
  });

  it("checks the timestamp again once a slow body has arrived", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { owner, triggerId } = await withTrigger();
    const id = "msg_slow";
    const raw = JSON.stringify({ ...message(triggerId, owner.userId), id });
    const timestamp = Math.floor(Date.now() / 1000);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        vi.setSystemTime(Date.now() + 360_000);
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const response = await h.fetch("/v1/composio/webhook", {
      method: "POST",
      body,
      duplex: "half",
      headers: { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${composioSignature(WEBHOOK_SECRET, id, timestamp, raw)}` },
    } as RequestInit);
    expect(response.status).toBe(401);
    expect(h.queued()).toEqual([]);
  });

  it("answers 503 until the owner sets COMPOSIO_WEBHOOK_SECRET, and 413 past 1 MB", async () => {
    const { owner, triggerId } = await withTrigger();
    expect((await h.deliver(message(triggerId, owner.userId), { tamper: (body) => body.padEnd(1024 * 1024 + 1, " ") })).status).toBe(413);
    h.env.COMPOSIO_WEBHOOK_SECRET = undefined;
    expect((await h.deliver(message(triggerId, owner.userId))).status).toBe(503);
    expect(h.queued()).toEqual([]);
  });
});

describe("streamed request bodies", () => {
  it("stops reading an installation's oversized MCP or JSON body once it passes the limit", async () => {
    const owner = await h.install();
    for (const [path, method] of [["/v1/mcp", "POST"], ["/v1/triggers", "POST"], ["/v1/triggers/ti_1", "PATCH"], ["/v1/installation/cloud", "PUT"]]) {
      const stream = streamedBody(64 * 1024, 64);
      const response = await h.call(owner, path, { ...stream.init, method });
      expect(response.status, path).toBe(413);
      expect(stream.read.cancelled, path).toBe(true);
      expect(stream.read.bytes, path).toBeLessThan(64 * 64 * 1024);
    }
    expect(h.composio.callsTo("/")).toEqual([]);
  });
});

describe("routing", () => {
  it("answers 200 for a trigger no installation binds, queues nothing and counts it", async () => {
    await withTrigger();
    const response = await h.deliver(message("ti_unknown", "omb_someone"));
    expect(response.status).toBe(200);
    expect(h.queued()).toEqual([]);
    expect(h.day("")).toMatchObject({ unrouted: 1 });
  });

  it("never queues an event whose Composio user is not the binding's installation", async () => {
    const { owner, triggerId } = await withTrigger();
    const other = await h.install();
    h.account(other);
    const response = await h.deliver(message(triggerId, other.userId));
    expect(response.status).toBe(200);
    const odd = message(triggerId, undefined);
    await h.deliver({ ...odd, metadata: { ...odd.metadata, user_id: 42 } });
    expect(h.queued(owner.id)).toEqual([]);
    expect(h.queued(other.id)).toEqual([]);
    expect(h.day("")).toMatchObject({ unrouted: 2 });
  });

  it("routes by binding when the event names no user", async () => {
    const { owner, triggerId } = await withTrigger();
    expect((await h.deliver(message(triggerId, undefined))).status).toBe(200);
    expect(h.queued(owner.id)).toHaveLength(1);
  });

  it("delivers once for one instance that two local triggers share; the server fans out", async () => {
    const { owner, accountId, triggerId } = await withTrigger();
    const second = await h.createTrigger(owner, accountId);
    expect(second.body.triggerId).toBe(triggerId);
    expect(h.d1.rows("SELECT * FROM trigger_bindings")).toHaveLength(1);
    await h.deliver(message(triggerId, owner.userId));
    expect(h.queued(owner.id)).toHaveLength(1);
  });

  it("queues nothing for a paused trigger", async () => {
    const { owner, triggerId } = await withTrigger();
    await h.call(owner, `/v1/triggers/${triggerId}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect((await h.deliver(message(triggerId, owner.userId))).status).toBe(200);
    expect(h.queued()).toEqual([]);
  });
});

describe("dedupe", () => {
  it("keeps one row for a webhook-id delivered twice, before and after it is acked", async () => {
    const { owner, triggerId } = await withTrigger();
    const event = message(triggerId, owner.userId, { subject: "once" }, "msg_retry");
    expect((await h.deliver(event)).status).toBe(200);
    expect((await h.deliver(event)).status).toBe(200);
    expect(h.d1.rows("SELECT * FROM events")).toHaveLength(1);
    const first = await pollBody(owner);
    expect(first.events.map((item) => item.id)).toEqual(["msg_retry"]);
    await pollBody(owner, `after=${first.cursor}`);
    expect((await h.deliver(event)).status).toBe(200);
    expect(h.queued()).toEqual([]);
    expect((await pollBody(owner, `after=${first.cursor}`)).events).toEqual([]);
    expect(h.day(owner.id)).toMatchObject({ queued: 1, duplicate: 2, delivered: 1 });
  });
});

describe("long-poll", () => {
  it("returns waiting events at once with the cursor of the last one", async () => {
    const { owner, triggerId } = await withTrigger();
    await h.deliver(message(triggerId, owner.userId, { subject: "Order #1042" }, "msg_a"));
    const body = await pollBody(owner, "wait=25");
    expect(body.events).toEqual([expect.objectContaining({
      id: "msg_a",
      kind: "message",
      triggerId,
      event: expect.objectContaining({ id: "msg_a", type: "composio.trigger.message", data: { subject: "Order #1042" } }),
    })]);
    expect(body.cursor).toBe(body.events[0].seq);
  });

  it("holds an empty poll and answers within 2 s of a new event", async () => {
    const { owner, triggerId } = await withTrigger();
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    let answered: Response | undefined;
    void h.poll(owner, "wait=25").then((response) => { answered = response; });
    await untilPollReads(1);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(answered).toBeUndefined();
    await h.deliver(message(triggerId, owner.userId, {}, "msg_late"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(answered?.status).toBe(200);
    expect((await answered!.json() as { events: Array<{ id: string }> }).events.map((event) => event.id)).toEqual(["msg_late"]);
  });

  it("answers an empty batch with the same cursor once the wait is over", async () => {
    const { owner } = await withTrigger();
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    let answered: Response | undefined;
    void h.poll(owner, "after=7&wait=3").then((response) => { answered = response; });
    await untilPollReads(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(answered).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(answered!.json()).resolves.toEqual({ events: [], cursor: 7 });
  });

  it("acks exactly the events at or below `after` and redelivers the rest", async () => {
    const { owner, triggerId } = await withTrigger();
    for (const id of ["msg_1", "msg_2", "msg_3"]) await h.deliver(message(triggerId, owner.userId, {}, id));
    const all = await pollBody(owner);
    expect(all.events.map((event) => event.id)).toEqual(["msg_1", "msg_2", "msg_3"]);
    expect(h.queued(owner.id)).toHaveLength(3);
    const [first, second, third] = all.events.map((event) => event.seq);

    const rest = await pollBody(owner, `after=${first}`);
    expect(rest.events.map((event) => event.id)).toEqual(["msg_2", "msg_3"]);
    expect(h.d1.rows("SELECT seq, body, acked_at FROM events ORDER BY seq")).toEqual([
      { seq: first, body: "", acked_at: expect.any(Number) },
      { seq: second, body: expect.stringContaining("msg_2"), acked_at: null },
      { seq: third, body: expect.stringContaining("msg_3"), acked_at: null },
    ]);
    expect((await pollBody(owner, `after=${third}`)).events).toEqual([]);
    expect(h.queued(owner.id)).toEqual([]);
    expect(h.day(owner.id)).toMatchObject({ queued: 3, delivered: 3 });
  });

  it("returns at most 50 events, in the order they arrived", async () => {
    const { owner, triggerId } = await withTrigger();
    await fill(owner, triggerId, 60);
    const page = await pollBody(owner, "limit=500");
    expect(page.events).toHaveLength(50);
    const seqs = page.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(page.cursor).toBe(seqs.at(-1));
    expect((await pollBody(owner, `after=${page.cursor}`)).events).toHaveLength(10);
  });

  it("gives each installation only its own events, in arrival order", async () => {
    const a = await withTrigger();
    const b = await withTrigger();
    for (let index = 0; index < 3; index += 1) {
      await h.deliver(message(a.triggerId, a.owner.userId, {}, `msg_a${index}`));
      await h.deliver(message(b.triggerId, b.owner.userId, {}, `msg_b${index}`));
    }
    expect((await pollBody(a.owner)).events.map((event) => event.id)).toEqual(["msg_a0", "msg_a1", "msg_a2"]);
    expect((await pollBody(b.owner)).events.map((event) => event.id)).toEqual(["msg_b0", "msg_b1", "msg_b2"]);
  });

  it("refuses a second poller while the first holds the lease, and lets it take over once the lease runs out", async () => {
    const { owner } = await withTrigger();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T10:00:00Z"));
    expect((await h.poll(owner, "", "server-one-0001")).status).toBe(200);
    const refused = await h.poll(owner, "", "server-two-0002");
    expect(refused.status).toBe(409);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(85);
    expect((await h.poll(owner, "", "server-one-0001")).status).toBe(200);
    vi.setSystemTime(new Date("2026-10-17T10:01:31Z"));
    expect((await h.poll(owner, "", "server-two-0002")).status).toBe(200);
    expect((await h.poll(owner, "", "server-one-0001")).status).toBe(409);
  });

  it("writes the lease only when a poll could outlast it", async () => {
    const { owner, triggerId } = await withTrigger();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T10:00:00Z"));
    const leaseWrites = () => h.d1.sqlLog.filter((sql) => sql.includes("SET poll_lease_id")).length;
    const at = (second: number) => vi.setSystemTime(new Date(Date.parse("2026-10-17T10:00:00Z") + second * 1000));
    for (const second of [0, 25, 50, 84]) {
      at(second);
      await pollBody(owner, "wait=0");
    }
    expect(leaseWrites()).toBe(1);
    at(86);
    await pollBody(owner, "wait=0");
    expect(leaseWrites()).toBe(2);
    // A 25 s hold from second 150 would end after the lease (second 176), so it renews first.
    at(150);
    await h.deliver(message(triggerId, owner.userId));
    await pollBody(owner, "wait=25");
    expect(leaseWrites()).toBe(3);
  });

  it("needs a poller id, its own rate limit and the installation token", async () => {
    const { owner } = await withTrigger();
    expect((await h.call(owner, "/v1/events")).status).toBe(400);
    expect((await h.fetch("/v1/events", { headers: { "x-omb-poller": "poller-main-0001" } })).status).toBe(401);
    h.limits.events = false;
    expect((await h.poll(owner)).status).toBe(429);
  });
});

describe("limits", () => {
  it("drops a desktop installation's 501st event of the UTC day and counts it on the trigger", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T08:00:00Z"));
    const { owner, triggerId } = await withTrigger();
    expect((await fill(owner, triggerId, 500)).every((result) => result.status === "queued")).toBe(true);
    expect((await h.deliver(message(triggerId, owner.userId))).status).toBe(200);
    expect(h.queued(owner.id)).toHaveLength(500);
    expect(h.drops(owner.id)).toEqual([{ composio_trigger_id: triggerId, reason: "daily_limit", dropped: 1 }]);
    expect(h.day(owner.id)).toMatchObject({ queued: 500, dropped_daily_limit: 1 });
    vi.setSystemTime(new Date("2026-10-18T00:00:01Z"));
    await h.deliver(message(triggerId, owner.userId));
    expect(h.queued(owner.id)).toHaveLength(501);
  });

  it("gives a paid Cloud 2,000 events a day", async () => {
    const cloud = await withTrigger();
    await asCloud(cloud.owner);
    expect((await fill(cloud.owner, cloud.triggerId, 600)).every((result) => result.status === "queued")).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    h.d1.db.prepare("UPDATE app_event_days SET queued = 1998 WHERE day = ? AND installation_id = ?").run(today, cloud.owner.id);
    await h.call(cloud.owner, `/v1/events?after=${Number.MAX_SAFE_INTEGER}`, { headers: { "x-omb-poller": "poller-main-0001" } });
    for (let index = 0; index < 3; index += 1) await h.deliver(message(cloud.triggerId, cloud.owner.userId));
    expect(h.queued(cloud.owner.id)).toHaveLength(2);
    expect(h.drops(cloud.owner.id)).toEqual([{ composio_trigger_id: cloud.triggerId, reason: "daily_limit", dropped: 1 }]);

    const desktop = await withTrigger();
    h.d1.db.prepare("INSERT INTO app_event_days (day, installation_id, queued) VALUES (?, ?, 1998)").run(today, desktop.owner.id);
    await h.deliver(message(desktop.triggerId, desktop.owner.userId));
    expect(h.queued(desktop.owner.id)).toEqual([]);
  });

  it("drops the 1,001st queued event until the server acks", async () => {
    const { owner, triggerId } = await withTrigger();
    await asCloud(owner);
    expect((await fill(owner, triggerId, 1000)).every((result) => result.status === "queued")).toBe(true);
    await h.deliver(message(triggerId, owner.userId, {}, "msg_1001"));
    expect(h.queued(owner.id)).toHaveLength(1000);
    expect(h.drops(owner.id)).toEqual([{ composio_trigger_id: triggerId, reason: "queue_full", dropped: 1 }]);
    const page = await pollBody(owner, "limit=1");
    await pollBody(owner, `after=${page.cursor}&limit=1`);
    await h.deliver(message(triggerId, owner.userId, {}, "msg_after_ack"));
    expect(h.queued(owner.id).at(-1)?.event_id).toBe("msg_after_ack");
  });

  it("drops an event that would take the queue past 20 MB", async () => {
    const { owner, triggerId } = await withTrigger();
    const mebibyte = `"${"x".repeat(1024 * 1024 - 2)}"`;
    expect((await fill(owner, triggerId, 20, mebibyte)).every((result) => result.status === "queued")).toBe(true);
    expect(h.d1.rows<{ total: number }>("SELECT SUM(bytes) AS total FROM events")[0].total).toBe(QUEUE_MAX_BYTES);
    expect(await fill(owner, triggerId, 1, "1")).toEqual([{ status: "dropped", reason: "queue_full" }]);
  });

  it("keeps an event's data to 64 KB, with a marker", async () => {
    const { owner, triggerId } = await withTrigger();
    await h.deliver(message(triggerId, owner.userId, { message_text: "y".repeat(100_000) }, "msg_big"));
    const [event] = (await pollBody(owner)).events;
    expect(event.event.data).toEqual({ omb_truncated: true, original_bytes: 100_019, preview: expect.any(String) });
    expect(new TextEncoder().encode(event.event.data.preview).byteLength).toBe(64 * 1024);
    expect(event.event.data.preview.startsWith('{"message_text":"yyy')).toBe(true);
  });

  it("always queues status events, even when the queue is full", async () => {
    const { owner, triggerId } = await withTrigger();
    await asCloud(owner);
    await fill(owner, triggerId, 1000);
    await h.deliver({ type: "composio.trigger.disabled", timestamp: new Date().toISOString(), metadata: { trigger_id: triggerId, user_id: owner.userId }, data: {} });
    expect(h.queued(owner.id).at(-1)).toMatchObject({ kind: "trigger_disabled", composio_trigger_id: triggerId });
  });

  it("puts a test event through the real queue and counts it against the limits", async () => {
    const { owner, triggerId } = await withTrigger();
    const sent = await h.call(owner, "/v1/events/test", { method: "POST", body: JSON.stringify({ triggerId, data: { subject: "TEST order" } }) });
    expect(sent.status).toBe(201);
    const [event] = (await pollBody(owner)).events;
    expect(event).toMatchObject({ kind: "test", triggerId, event: { type: "omb.test", data: { subject: "TEST order" }, metadata: { trigger_slug: GMAIL_TYPE.slug } } });
    h.d1.db.prepare("UPDATE app_event_days SET queued = 500 WHERE installation_id = ?").run(owner.id);
    const refused = await h.call(owner, "/v1/events/test", { method: "POST", body: JSON.stringify({ triggerId, data: {} }) });
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({ queued: false, dropped: "daily_limit" });
    expect((await h.call(owner, "/v1/events/test", { method: "POST", body: JSON.stringify({ triggerId: "ti_other", data: {} }) })).status).toBe(404);
  });
});

describe("hourly job", () => {
  it("expires events not delivered within 7 days into the trigger's drop count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-01T12:00:00Z");
    vi.setSystemTime(start);
    const { owner, triggerId } = await withTrigger();
    await h.deliver(message(triggerId, owner.userId, {}, "msg_acked"));
    await pollBody(owner, `after=${(await pollBody(owner)).cursor}`);
    await h.deliver(message(triggerId, owner.userId, {}, "msg_old"));
    vi.setSystemTime(start + 2 * DAY_MS);
    await h.deliver(message(triggerId, owner.userId, {}, "msg_recent"));

    await runHourly(h.env as never, start + 7 * DAY_MS - 1);
    expect(h.d1.rows("SELECT event_id FROM events ORDER BY seq")).toHaveLength(3);
    await runHourly(h.env as never, start + 7 * DAY_MS + 1);
    expect(h.d1.rows("SELECT event_id FROM events ORDER BY seq")).toEqual([{ event_id: "msg_recent" }]);
    expect(h.drops(owner.id)).toEqual([{ composio_trigger_id: triggerId, reason: "expired", dropped: 1 }]);
    expect(h.day(owner.id, "2026-10-08")).toMatchObject({ expired: 1 });
  });

  it("disables at Composio the triggers of an installation idle for 14 days, once, and re-enables them on its next poll", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-01T12:00:00Z");
    vi.setSystemTime(start);
    const idle = await withTrigger();
    await pollBody(idle.owner);
    const neverPolled = await withTrigger({ query: "label:inbox" });
    vi.setSystemTime(start + 2 * DAY_MS);
    const active = await withTrigger({ query: "from:boss" });
    await pollBody(active.owner);
    const disables = () => h.composio.callsTo("/trigger_instances/manage/")
      .filter((call) => call.method === "PATCH" && call.body?.status === "disable").map((call) => call.path.split("/").at(-1));

    await runHourly(h.env as never, start + 14 * DAY_MS + 60_000);
    expect(disables().sort()).toEqual([idle.triggerId, neverPolled.triggerId].sort());
    expect(h.composio.instances.get(idle.triggerId)?.disabled_at).not.toBeNull();
    expect(h.composio.instances.get(active.triggerId)?.disabled_at).toBeNull();
    await runHourly(h.env as never, start + 14 * DAY_MS + 2 * 60 * 60_000);
    expect(disables()).toHaveLength(2);
    expect(h.d1.rows("SELECT disabled_at FROM trigger_bindings WHERE disabled_at IS NOT NULL")).toEqual([]);

    vi.setSystemTime(start + 15 * DAY_MS);
    await pollBody(idle.owner);
    await Promise.all(h.background);
    expect(h.composio.instances.get(idle.triggerId)?.disabled_at).toBeNull();
    expect(h.d1.rows("SELECT triggers_swept_at FROM installations WHERE id = ?", idle.owner.id)).toEqual([{ triggers_swept_at: null }]);
  });

  it("sweeps an installation with more triggers than one run may disable over several runs, then the next one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-01T12:00:00Z");
    vi.setSystemTime(start);
    const big = await h.install();
    const bigAccount = h.account(big);
    const bigTriggers: string[] = [];
    for (let index = 0; index < 45; index += 1) {
      const { response, body } = await h.createTrigger(big, bigAccount, { query: `subject:order-${index}` });
      expect(response.status).toBe(201);
      bigTriggers.push(body.triggerId);
    }
    const small = await withTrigger({ query: "label:inbox" });
    const changes = (status: string) => h.composio.callsTo("/trigger_instances/manage/")
      .filter((call) => call.method === "PATCH" && call.body?.status === status).map((call) => call.path.split("/").at(-1)!);

    for (let hour = 1; hour <= 3; hour += 1) await runHourly(h.env as never, start + 14 * DAY_MS + hour * 60 * 60_000);
    expect(changes("disable").sort()).toEqual([...bigTriggers, small.triggerId].sort());
    expect([...h.composio.instances.values()].filter((instance) => !instance.disabled_at)).toEqual([]);
    expect(h.d1.rows("SELECT disabled_at FROM trigger_bindings WHERE disabled_at IS NOT NULL")).toEqual([]);

    vi.setSystemTime(start + 15 * DAY_MS);
    await pollBody(big);
    await Promise.all(h.background);
    await pollBody(big);
    await Promise.all(h.background);
    expect(changes("enable").sort()).toEqual([...bigTriggers].sort());
    expect(bigTriggers.filter((id) => h.composio.instances.get(id)?.disabled_at)).toEqual([]);
    expect(h.composio.instances.get(small.triggerId)?.disabled_at).not.toBeNull();
  });

  it("keeps daily counts for 90 days", async () => {
    h.d1.db.exec("INSERT INTO app_event_days (day, installation_id, queued) VALUES ('2026-07-01', 'x', 1), ('2026-09-30', 'x', 1)");
    await runHourly(h.env as never, Date.parse("2026-10-17T12:00:00Z"));
    expect(h.d1.rows("SELECT day FROM app_event_days")).toEqual([{ day: "2026-09-30" }]);
  });
});

describe("trigger bindings", () => {
  it("never reaches Composio's trigger API for an account another installation owns", async () => {
    const owner = await h.install();
    h.account(owner);
    const other = await h.install();
    const theirs = h.account(other);
    const { response } = await h.createTrigger(owner, theirs);
    expect(response.status).toBe(403);
    expect(h.composio.callsTo("/trigger_instances")).toEqual([]);
    expect(h.composio.callsTo("/triggers_types")).toEqual([]);
    expect(h.d1.rows("SELECT * FROM trigger_bindings")).toEqual([]);
  });

  it("creates the instance with Composio's upsert for the installation's user and binds it", async () => {
    const owner = await h.install();
    const accountId = h.account(owner);
    const { response, body } = await h.createTrigger(owner, accountId, { query: "subject:order" }, "gmail_new_gmail_message");
    expect(response.status).toBe(201);
    expect(body).toEqual({ triggerId: "ti_1", slug: GMAIL_TYPE.slug, toolkit: "gmail", connectedAccountId: accountId, enabled: true });
    const [upsert] = h.composio.callsTo("/trigger_instances/");
    expect(upsert.path).toBe(`/trigger_instances/${GMAIL_TYPE.slug}/upsert`);
    expect(upsert.body).toEqual({ connected_account_id: accountId, user_id: owner.userId, trigger_config: { query: "subject:order" }, toolkit_versions: "latest" });
    expect(h.d1.rows("SELECT installation_id, composio_trigger_id, toolkit, trigger_slug, disabled_at FROM trigger_bindings")).toEqual([
      { installation_id: owner.id, composio_trigger_id: "ti_1", toolkit: "gmail", trigger_slug: GMAIL_TYPE.slug, disabled_at: null },
    ]);
  });

  it("refuses another toolkit's event, an unknown one and one that needs its own endpoint before any upsert", async () => {
    const owner = await h.install();
    const accountId = h.account(owner);
    expect((await h.createTrigger(owner, accountId, {}, "SLACK_CHANNEL_MESSAGE_RECEIVED")).response.status).toBe(400);
    expect((await h.createTrigger(owner, accountId, {}, "GMAIL_NOT_A_THING")).response.status).toBe(404);
    expect((await h.createTrigger(owner, accountId, {}, "GMAIL_OWN_ENDPOINT")).response.status).toBe(404);
    expect(h.composio.callsTo("/trigger_instances")).toEqual([]);
    h.composio.fail(400, (call) => call.path.endsWith("/upsert"));
    const rejected = await h.createTrigger(owner, accountId, { interval: "often" });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toBe("injected 400");
  });

  it("pauses and resumes at Composio, taking 'already in that state' as done, and changes no config in place", async () => {
    const { owner, triggerId } = await withTrigger();
    const patch = (body: unknown) => h.call(owner, `/v1/triggers/${triggerId}`, { method: "PATCH", body: JSON.stringify(body) });
    expect((await patch({ enabled: false })).status).toBe(200);
    expect(h.composio.instances.get(triggerId)?.disabled_at).not.toBeNull();
    expect(h.d1.rows("SELECT disabled_at FROM trigger_bindings")).toEqual([{ disabled_at: expect.any(Number) }]);
    expect((await patch({ enabled: false })).status).toBe(200);
    expect((await patch({ enabled: true })).status).toBe(200);
    expect(h.composio.instances.get(triggerId)?.disabled_at).toBeNull();
    expect(h.d1.rows("SELECT disabled_at FROM trigger_bindings")).toEqual([{ disabled_at: null }]);
    expect((await patch({ enabled: true, config: { query: "x" } })).status).toBe(400);
    h.composio.instances.delete(triggerId);
    expect(await (await patch({ enabled: true })).json()).toMatchObject({ remote: "missing" });
  });

  it("deletes the instance, the binding, its queued events and its drop counts", async () => {
    const { owner, triggerId } = await withTrigger();
    await h.deliver(message(triggerId, owner.userId));
    h.d1.db.prepare("INSERT INTO event_drops VALUES (?, ?, 'queue_full', 3, 1)").run(owner.id, triggerId);
    const response = await h.call(owner, `/v1/triggers/${triggerId}`, { method: "DELETE" });
    await expect(response.json()).resolves.toEqual({ removed: 1 });
    expect(h.composio.instances.has(triggerId)).toBe(false);
    expect(h.d1.rows("SELECT * FROM trigger_bindings")).toEqual([]);
    expect(h.queued()).toEqual([]);
    expect(h.drops(owner.id)).toEqual([]);
    await h.deliver(message(triggerId, owner.userId));
    expect(h.queued()).toEqual([]);
    await expect((await h.call(owner, `/v1/triggers/${triggerId}`, { method: "DELETE" })).json()).resolves.toEqual({ removed: 0 });
  });

  it("changes a shared instance at Composio only for the last binding", async () => {
    const { owner, triggerId } = await withTrigger();
    const other = await h.install();
    h.d1.db.prepare("INSERT INTO trigger_bindings VALUES (?, ?, 'gmail', ?, 'ca_x', 1, NULL, NULL)").run(other.id, triggerId, GMAIL_TYPE.slug);
    await h.call(owner, `/v1/triggers/${triggerId}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect(h.composio.callsTo("/trigger_instances/manage/").map((call) => call.body?.status)).toEqual(["enable"]);
    expect(h.composio.instances.get(triggerId)?.disabled_at).toBeNull();
    await h.call(owner, `/v1/triggers/${triggerId}`, { method: "DELETE" });
    expect(h.composio.instances.has(triggerId)).toBe(true);
    await h.call(other, `/v1/triggers/${triggerId}`, { method: "DELETE" });
    expect(h.composio.instances.has(triggerId)).toBe(false);
  });

  it("deletes an unbound instance of its own Composio user, never another user's", async () => {
    const { owner, accountId } = await withTrigger();
    const other = await h.install();
    const base = { trigger_name: GMAIL_TYPE.slug, trigger_config: {}, disabled_at: null };
    h.composio.instances.set("ti_orphan", { ...base, id: "ti_orphan", connected_account_id: accountId, user_id: owner.userId });
    h.composio.instances.set("ti_theirs", { ...base, id: "ti_theirs", connected_account_id: "ca_theirs", user_id: other.userId });
    await expect((await h.call(owner, "/v1/triggers/ti_orphan", { method: "DELETE" })).json()).resolves.toEqual({ removed: 1 });
    await expect((await h.call(owner, "/v1/triggers/ti_theirs", { method: "DELETE" })).json()).resolves.toEqual({ removed: 0 });
    expect([...h.composio.instances.keys()].sort()).toEqual(["ti_1", "ti_theirs"]);
  });

  it("lists bindings beside Composio's state, unbound instances, drops, limits and usage for reconciliation", async () => {
    const owner = await h.install();
    const accountId = h.account(owner);
    const enabled = (await h.createTrigger(owner, accountId, { query: "a" })).body.triggerId;
    const disabledRemote = (await h.createTrigger(owner, accountId, { query: "b" })).body.triggerId;
    const missing = (await h.createTrigger(owner, accountId, { query: "c" })).body.triggerId;
    h.composio.instances.get(disabledRemote)!.disabled_at = "2026-10-17T00:00:00Z";
    h.composio.instances.delete(missing);
    h.composio.instances.set("ti_orphan", { id: "ti_orphan", trigger_name: GMAIL_TYPE.slug, connected_account_id: accountId, user_id: owner.userId, trigger_config: {}, disabled_at: null });
    await h.deliver(message(enabled, owner.userId));
    h.d1.db.prepare("INSERT INTO event_drops VALUES (?, ?, 'daily_limit', 4, 99)").run(owner.id, enabled);

    const body = await (await h.call(owner, "/v1/triggers")).json() as Record<string, any>;
    expect(body.triggers.map((trigger: Record<string, any>) => [trigger.triggerId, trigger.enabled, trigger.remote?.state])).toEqual([
      [enabled, true, "enabled"], [disabledRemote, true, "disabled"], [missing, true, "missing"],
    ]);
    expect(body.triggers[0]).toMatchObject({ slug: GMAIL_TYPE.slug, toolkit: "gmail", connectedAccountId: accountId, remote: { config: { query: "a" } }, dropped: { daily_limit: { count: 4, lastAt: 99 } } });
    expect(body.unbound).toEqual([{ triggerId: "ti_orphan", slug: GMAIL_TYPE.slug, connectedAccountId: accountId, enabled: true }]);
    expect(body.limits).toEqual({ plan: "desktop", eventsPerDay: 500, queuedEvents: 1000, queuedBytes: QUEUE_MAX_BYTES });
    expect(body.usage).toMatchObject({ eventsToday: 1, queuedEvents: 1 });

    h.composio.fail(503, (call) => call.path === "/trigger_instances/active");
    const degraded = await (await h.call(owner, "/v1/triggers")).json() as Record<string, any>;
    expect(degraded).toMatchObject({ unbound: null, remoteError: "injected 503" });
    expect(degraded.triggers[0].remote).toBeNull();
  });
});

describe("event types", () => {
  it("lists the event types of the installation's connected apps, hiding ones that need their own endpoint, and caches them", async () => {
    const owner = await h.install();
    h.account(owner, "gmail");
    h.account(owner, "slack", "EXPIRED");
    const body = await (await h.call(owner, "/v1/trigger-types")).json() as { toolkits: Record<string, { types: Array<{ slug: string }> }>; notLoaded: string[] };
    expect(Object.keys(body.toolkits)).toEqual(["gmail"]);
    expect(body.toolkits.gmail.types.map((type) => type.slug)).toEqual(["GMAIL_NEW_GMAIL_MESSAGE", "GMAIL_EMAIL_SENT"]);
    expect(body.toolkits.gmail.types[0]).toEqual({
      slug: GMAIL_TYPE.slug, toolkit: "gmail", name: GMAIL_TYPE.name, description: GMAIL_TYPE.description, type: "poll",
      config: GMAIL_TYPE.config, payload: GMAIL_TYPE.payload, version: GMAIL_TYPE.version,
    });
    const typeCalls = h.composio.callsTo("/triggers_types");
    expect(typeCalls.map((call) => call.query.get("cursor"))).toEqual([null, "2"]);
    expect(typeCalls[0].query.get("toolkit_versions")).toBe("latest");
    await h.call(owner, "/v1/trigger-types?toolkits=gmail");
    expect(h.composio.callsTo("/triggers_types")).toHaveLength(2);

    const slack = await (await h.call(owner, "/v1/trigger-types?toolkits=slack,Slack")).json() as typeof body;
    expect(Object.keys(slack.toolkits)).toEqual(["slack"]);
    expect((await h.call(owner, `/v1/trigger-types?toolkits=${Array.from({ length: 11 }, (_, index) => `t${index}`).join(",")}`)).status).toBe(400);
    expect((await h.call(owner, `/v1/trigger-types/${GMAIL_TYPE.slug.toLowerCase()}`)).status).toBe(200);
    expect((await h.call(owner, "/v1/trigger-types/GMAIL_NOT_A_THING")).status).toBe(404);
  });
});

describe("status events", () => {
  it("queues trigger.disabled only for the installation that binds the trigger", async () => {
    const a = await withTrigger();
    const b = await withTrigger({ query: "other" });
    await h.deliver({ type: "composio.trigger.disabled", timestamp: new Date().toISOString(), metadata: { trigger_id: a.triggerId }, data: { reason: "too many failures" } });
    expect(h.queued(a.owner.id)).toEqual([expect.objectContaining({ kind: "trigger_disabled", composio_trigger_id: a.triggerId })]);
    expect(h.queued(b.owner.id)).toEqual([]);
  });

  it("queues connected_account.expired for installations with a trigger on that account, without the account record", async () => {
    const a = await withTrigger();
    const b = await withTrigger();
    await h.deliver({
      type: "composio.connected_account.expired",
      timestamp: new Date().toISOString(),
      metadata: { project_id: "pr_1", org_id: "org_1" },
      data: {
        id: a.accountId, user_id: a.owner.userId, toolkit: { slug: "gmail" }, status: "EXPIRED", status_reason: "refresh failed",
        state: { authScheme: "OAUTH2", val: { access_token: "ya29.secret-token" } },
      },
    });
    const [queued] = h.queued(a.owner.id);
    expect(queued).toMatchObject({ kind: "account_expired", composio_trigger_id: null });
    expect(JSON.parse(queued.body).data).toEqual({ connected_account_id: a.accountId, toolkit: "gmail", status_reason: "refresh failed" });
    expect(queued.body).not.toContain("secret-token");
    expect(h.queued(b.owner.id)).toEqual([]);
  });
});

describe("paid Cloud", () => {
  it("marks an installation as a paid Cloud's from an Admin-signed grant", async () => {
    const { owner } = await withTrigger();
    const response = await h.call(owner, "/v1/installation/cloud", { method: "PUT", body: JSON.stringify({ grant: cloudGrant("omb-machine-1") }) });
    await expect(response.json()).resolves.toEqual({ plan: "cloud", eventsPerDay: 2000 });
    expect((await (await h.call(owner, "/v1/triggers")).json() as { limits: unknown }).limits).toMatchObject({ plan: "cloud", eventsPerDay: 2000 });
  });

  it("refuses a grant signed with another key or naming another machine", async () => {
    const { owner } = await withTrigger();
    const forged = cloudGrant("omb-machine-1", "someone-elses-key");
    const valid = cloudGrant("omb-machine-1");
    const renamed = valid.replace("omb-machine-1", "omb-machine-2");
    for (const grant of [forged, renamed, "v1.omb-machine-1.", "cloud", valid.slice(0, -1)]) {
      expect((await h.call(owner, "/v1/installation/cloud", { method: "PUT", body: JSON.stringify({ grant }) })).status).toBe(403);
    }
    expect(h.d1.rows("SELECT cloud_machine_id FROM installations")).toEqual([{ cloud_machine_id: null }]);
  });

  it("moves the Cloud limit to the installation that last presented the grant", async () => {
    const first = await h.install();
    const second = await h.install();
    await asCloud(first, "omb-machine-1");
    await asCloud(second, "omb-machine-1");
    expect(h.d1.rows("SELECT id, cloud_machine_id FROM installations ORDER BY cloud_machine_id")).toEqual(expect.arrayContaining([
      { id: first.id, cloud_machine_id: null },
      { id: second.id, cloud_machine_id: "omb-machine-1" },
    ]));
  });

  it("answers 503 until CLOUD_GRANT_SECRET is set", async () => {
    const owner = await h.install();
    h.env.CLOUD_GRANT_SECRET = undefined;
    expect((await h.call(owner, "/v1/installation/cloud", { method: "PUT", body: JSON.stringify({ grant: cloudGrant("omb-machine-1") }) })).status).toBe(503);
  });
});

describe("waking a sleeping Cloud for its events", () => {
  const ADMIN = "https://cloud-admin.test";
  const MACHINE = "omb-machine-1";
  let wakes: Array<{ url: string; method: string; headers: Headers; body: string }>;
  let answer: () => Promise<Response>;
  const at = (ms: number) => vi.setSystemTime(new Date(ms));
  const T0 = Date.parse("2026-10-19T10:00:00Z");

  beforeEach(() => {
    wakes = [];
    answer = async () => Response.json({ waking: true }, { status: 202 });
    h.env.CLOUD_ADMIN_URL = ADMIN;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== ADMIN) return h.composio.fetchImpl(input, init);
      wakes.push({ url: url.href, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body) });
      return answer();
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    at(T0);
  });

  async function cloudTrigger() {
    const { owner, triggerId } = await withTrigger();
    await asCloud(owner, MACHINE);
    return { owner, triggerId };
  }
  async function deliver(owner: Installation, triggerId: string) {
    const response = await h.deliver(message(triggerId, owner.userId));
    expect(response.status).toBe(200);
    await Promise.all(h.background);
  }

  it("asks the Admin once, signed with the Cloud grant key over exactly the timestamp and machine id", async () => {
    const { owner, triggerId } = await cloudTrigger();
    await deliver(owner, triggerId);
    expect(h.queued(owner.id)).toHaveLength(1);
    expect(wakes).toHaveLength(1);
    const [wake] = wakes;
    const timestamp = String(Math.floor(T0 / 1000));
    expect(wake.url).toBe(`${ADMIN}/api/cloud/machines/wake`);
    expect(wake.method).toBe("POST");
    expect(wake.body).toBe(`{"machineId":"${MACHINE}"}`);
    expect(wake.headers.get("content-type")).toBe("application/json");
    expect(wake.headers.get("x-omb-wake-timestamp")).toBe(timestamp);
    const expected = createHmac("sha256", CLOUD_GRANT_SECRET).update(`omb-cloud-wake:v1\n${timestamp}\n${MACHINE}`).digest("base64url");
    expect(wake.headers.get("x-omb-wake-signature")).toBe(`v1=${expected}`);
    expect(h.d1.rows("SELECT wake_requested_at FROM installations WHERE id = ?", owner.id)).toEqual([{ wake_requested_at: T0 }]);
  });

  it("asks at most once a minute per installation", async () => {
    const { owner, triggerId } = await cloudTrigger();
    await deliver(owner, triggerId);
    at(T0 + WAKE_EVERY_MS - 1_000);
    await deliver(owner, triggerId);
    expect(wakes).toHaveLength(1);
    at(T0 + WAKE_EVERY_MS);
    await deliver(owner, triggerId);
    expect(wakes).toHaveLength(2);
    expect(h.queued(owner.id)).toHaveLength(3);
  });

  it("asks nothing while the Cloud holds its poll lease, and again once the lease ran out", async () => {
    const { owner, triggerId } = await cloudTrigger();
    await pollBody(owner, "wait=0");
    await deliver(owner, triggerId);
    expect(wakes).toEqual([]);
    at(T0 + 91_000);
    await deliver(owner, triggerId);
    expect(wakes).toHaveLength(1);
  });

  it("asks nothing for a desktop installation, a dropped or duplicate event, or without both settings", async () => {
    const desktop = await withTrigger();
    await deliver(desktop.owner, desktop.triggerId);
    expect(wakes).toEqual([]);

    const { owner, triggerId } = await cloudTrigger();
    const event = message(triggerId, owner.userId, undefined, "msg_once");
    await h.deliver(event);
    await Promise.all(h.background);
    at(T0 + 2 * WAKE_EVERY_MS);
    await h.deliver(event);
    await Promise.all(h.background);
    expect(wakes).toHaveLength(1);

    h.env.CLOUD_ADMIN_URL = undefined;
    at(T0 + 4 * WAKE_EVERY_MS);
    await deliver(owner, triggerId);
    h.env.CLOUD_ADMIN_URL = ADMIN;
    h.env.CLOUD_GRANT_SECRET = undefined;
    at(T0 + 6 * WAKE_EVERY_MS);
    await deliver(owner, triggerId);
    h.env.CLOUD_GRANT_SECRET = CLOUD_GRANT_SECRET;
    h.env.CLOUD_ADMIN_URL = "http://cloud-admin.test";
    at(T0 + 8 * WAKE_EVERY_MS);
    await deliver(owner, triggerId);
    expect(wakes).toHaveLength(1);
    expect(h.d1.rows("SELECT wake_requested_at FROM installations WHERE id = ?", owner.id)).toEqual([{ wake_requested_at: T0 }]);
  });

  it("queues the event and answers Composio 200 when the Admin refuses, fails or can't be reached", async () => {
    const { owner, triggerId } = await cloudTrigger();
    const warnings = vi.mocked(console.warn);
    answer = async () => Response.json({ error: "bad signature" }, { status: 401 });
    await deliver(owner, triggerId);
    at(T0 + WAKE_EVERY_MS);
    answer = async () => { throw new TypeError("fetch failed"); };
    await deliver(owner, triggerId);
    expect(wakes).toHaveLength(2);
    expect(h.queued(owner.id)).toHaveLength(2);
    const logged = warnings.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("cloud wake"));
    expect(logged).toHaveLength(2);
    for (const line of logged) expect(line).not.toContain(CLOUD_GRANT_SECRET);
  });

  it("answers Composio without waiting for the Admin", async () => {
    const { owner, triggerId } = await cloudTrigger();
    let release!: () => void;
    answer = () => new Promise((resolve) => { release = () => resolve(Response.json({ waking: true }, { status: 202 })); });
    const response = await h.deliver(message(triggerId, owner.userId));
    expect(response.status).toBe(200);
    expect(h.background).toHaveLength(1);
    for (let turn = 0; !release && turn < 1000; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all(h.background);
    expect(wakes).toHaveLength(1);
  });
});

describe("fleet counter", () => {
  it("gives Admin daily totals with no event contents or installation ids", async () => {
    const { owner, triggerId } = await withTrigger();
    await h.deliver(message(triggerId, owner.userId, { subject: "TOP-SECRET-SUBJECT" }, "msg_1"));
    await h.deliver(message(triggerId, owner.userId, { subject: "TOP-SECRET-SUBJECT" }, "msg_1"));
    await h.deliver(message("ti_nobody", undefined));
    await pollBody(owner, `after=${(await pollBody(owner)).cursor}`);

    expect((await h.fetch("/v1/stats/app-events")).status).toBe(401);
    expect((await h.fetch("/v1/stats/app-events", { headers: { authorization: `Bearer ${owner.token}` } })).status).toBe(401);
    const response = await h.fetch("/v1/stats/app-events?days=7", { headers: { authorization: `Bearer ${STATS_TOKEN}` } });
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      days: [{ day: new Date().toISOString().slice(0, 10), queued: 1, delivered: 1, duplicate: 1, droppedDailyLimit: 0, droppedQueueFull: 0, expired: 0, unrouted: 1, installations: 1 }],
      current: { bindings: 1, enabledBindings: 1, installationsWithTriggers: 1, cloudInstallations: 0, polledLastHour: 1, queuedEvents: 0, queuedBytes: 0 },
    });
    for (const secret of ["TOP-SECRET-SUBJECT", owner.id, owner.userId, triggerId]) expect(text).not.toContain(secret);
    h.env.STATS_TOKEN = undefined;
    expect((await h.fetch("/v1/stats/app-events", { headers: { authorization: `Bearer ${STATS_TOKEN}` } })).status).toBe(404);
  });
});

describe("deploy order", () => {
  it("queues app events for a Cloud on a database without migration 0003, without asking the Admin", async () => {
    h = brokerHarness({ migrations: 2 });
    h.env.CLOUD_ADMIN_URL = "https://cloud-admin.test";
    const admin: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).hostname === "cloud-admin.test") { admin.push(String(input)); return Response.json({}, { status: 202 }); }
      return h.composio.fetchImpl(input, init);
    });
    const { owner, triggerId } = await withTrigger();
    await asCloud(owner, "omb-machine-1");
    expect((await h.deliver(message(triggerId, owner.userId))).status).toBe(200);
    await Promise.all(h.background);
    expect(h.queued(owner.id)).toHaveLength(1);
    expect(admin).toEqual([]);
    expect(vi.mocked(console.warn).mock.calls.some(([line]) => String(line).includes("cloud wake failed"))).toBe(true);
  });

  it("still answers polls and expires events on a database without migration 0005", async () => {
    h = brokerHarness({ migrations: 4 });
    vi.stubGlobal("fetch", h.composio.fetchImpl);
    const { owner, triggerId } = await withTrigger();
    await h.deliver(message(triggerId, owner.userId));
    h.d1.db.prepare("UPDATE installations SET triggers_swept_at = 1 WHERE id = ?").run(owner.id);
    expect((await h.poll(owner)).status).toBe(200);
    await Promise.allSettled(h.background);
    await expect(runHourly(h.env as never, Date.now() + 15 * DAY_MS)).rejects.toThrow(/swept_at/);
    expect(h.queued()).toEqual([]);
  });

  it("keeps the existing routes working on a database that has not run migration 0002", async () => {
    h = brokerHarness({ migrations: 1 });
    vi.stubGlobal("fetch", h.composio.fetchImpl);
    const owner = await h.install();
    const me = await h.call(owner, "/v1/me");
    await expect(me.json()).resolves.toEqual({ installationId: owner.id });
    expect((await h.call(owner, "/v1/triggers")).status).toBe(503);
    expect(WEBHOOK_SECRET).toBeTruthy();
  });
});
