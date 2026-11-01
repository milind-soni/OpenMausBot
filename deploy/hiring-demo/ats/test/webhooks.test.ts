import { test } from "node:test";
import assert from "node:assert/strict";

import { createDesk } from "../src/desk.ts";
import { createSim } from "../src/sim.ts";
import { createWebhookNotifier } from "../src/webhooks.ts";
import { candidateId, makeStore } from "./helpers.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (() => Promise<Response>)[]) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  }) as typeof fetch;
  return { calls, impl };
}

const ok = () => Promise.resolve(new Response(null, { status: 202 }));
const URL_ = "http://127.0.0.1:8800/hooks/wh_abc/secret123";

function setup(responses = [ok], cfg: { url: string | null; secret: string | null } = { url: URL_, secret: null }) {
  const store = makeStore();
  const desk = createDesk(store);
  const sim = createSim(store, desk);
  const f = fakeFetch(responses);
  const notifier = createWebhookNotifier(store, cfg, f.impl, { retryDelaysMs: [0, 0] });
  return { store, desk, sim, notifier, calls: f.calls };
}

const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);
const body = (c: Call) => JSON.parse(String(c.init.body));

test("maps client email to requirement.email_received with headers", async () => {
  const { sim, notifier, calls } = setup([ok], { url: URL_, secret: "tok" });
  const email = sim.deliverClientEmail();
  await notifier.idle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, URL_);
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(header(calls[0]!, "x-event-type"), "requirement.email_received");
  assert.equal(header(calls[0]!, "content-type"), "application/json");
  assert.equal(header(calls[0]!, "authorization"), "Bearer tok");
  assert.ok(header(calls[0]!, "idempotency-key")?.includes(email.id));
  const b = body(calls[0]!);
  assert.equal(b.email_id, email.id);
  assert.equal(b.subject, email.subject);
  assert.match(b.summary, /client requirement/i);
});

test("text-channel screen does not fire; voice does", async () => {
  const { store, desk, sim, notifier, calls } = setup();
  const email = sim.deliverClientEmail();
  await notifier.idle();
  const { req_id } = desk.createRequirement({
    actor: "Desk Manager", source_email_id: email.id, title: "Senior Java Developer", client: "Contoso Health",
    client_contact: "dana.whitfield@contosohealth.example.com", location: "Dallas, TX", work_mode: "hybrid", rate: 68,
    employment_type: "C2C", skills: ["Spring Boot", "AWS", "Kafka"], min_years: 8, jd: "Spring Boot, AWS, Kafka. 8+ years.",
  });
  const [ana, kiran] = ["Ana Souza", "Kiran Rao"].map((n) => candidateId(store, n));
  desk.addCandidatesToRequirement({ actor: "Job Board Sourcer", req_id, candidate_ids: [ana!, kiran!], source: "dice" });
  const screen = { actor: "Phone Screener" as const, req_id, interested: true, availability: "2 weeks", notice_period: "2 weeks",
    pay_expectation: "$65/hr", location_ok: true, work_auth_confirmed: true, notes: "", verdict: "pass" as const };
  desk.logScreenResult({ ...screen, candidate_id: ana!, channel: "text" });
  await notifier.idle();
  assert.equal(calls.length, 1);
  desk.logScreenResult({ ...screen, candidate_id: kiran!, channel: "voice" });
  await notifier.idle();
  assert.equal(calls.length, 2);
  assert.equal(header(calls[1]!, "x-event-type"), "screen.logged");
  assert.deepEqual({ ...body(calls[1]!), summary: undefined }, { summary: undefined, req_id, candidate_id: kiran, candidate_name: "Kiran Rao", verdict: "pass" });
});

test("morning events map to desk.morning_events", async () => {
  const { sim, notifier, calls } = setup();
  const [feedback, offer] = sim.deliverMorningEvents();
  await notifier.idle();
  assert.equal(header(calls[0]!, "x-event-type"), "desk.morning_events");
  const b = body(calls[0]!);
  assert.equal(b.feedback_email_id, feedback!.id);
  assert.equal(b.offer_accepted_email_id, offer!.id);
  assert.equal(b.timesheet_month, "2026-10");
});

test("retries then logs not reachable without throwing", async () => {
  const down = () => Promise.reject(new TypeError("fetch failed"));
  const { store, sim, notifier, calls } = setup([down]);
  const events: string[] = [];
  store.on((e) => events.push(e.name));
  sim.deliverClientEmail();
  await notifier.idle();
  assert.equal(calls.length, 3);
  assert.match(store.state.activity.at(-1)!.text, /Desk Manager not reachable/);
  assert.equal(store.state.activity.at(-1)!.actor, "Desk ATS");
  assert.ok(events.includes("webhook_failed"));
});

test("a non-2xx response counts as a failure, a later success stops retrying", async () => {
  const busy = () => Promise.resolve(new Response("busy", { status: 429 }));
  const { store, sim, notifier, calls } = setup([busy, ok]);
  sim.deliverClientEmail();
  await notifier.idle();
  assert.equal(calls.length, 2);
  assert.doesNotMatch(store.state.activity.at(-1)!.text, /not reachable/);
});

test("null url sends nothing", async () => {
  const { store, sim, notifier, calls } = setup([ok], { url: null, secret: null });
  sim.deliverClientEmail();
  await notifier.idle();
  assert.equal(calls.length, 0);
  assert.ok(store.state.activity.some((a) => /Webhook not configured/.test(a.text)));
});

test("client-email keys differ across runs after a reset, so MausBot never drops them as duplicates", async () => {
  const { store, sim, notifier, calls } = setup();
  sim.deliverClientEmail();
  await notifier.idle();
  store.reset();
  // A later run: the clock moves on, the email id repeats (EM-0001).
  (store as { now: () => number }).now = () => 2_000_000;
  sim.deliverClientEmail();
  await notifier.idle();
  assert.equal(calls.length, 2);
  assert.notEqual(header(calls[0]!, "idempotency-key"), header(calls[1]!, "idempotency-key"));
});

test("retries reuse one idempotency key", async () => {
  const down = () => Promise.reject(new TypeError("fetch failed"));
  const { sim, notifier, calls } = setup([down]);
  sim.deliverClientEmail();
  await notifier.idle();
  assert.equal(new Set(calls.map((c) => header(c, "idempotency-key"))).size, 1);
});

test("a 202 marked duplicate or ignored is reported as not started", async () => {
  for (const flag of ["duplicate", "ignored"]) {
    const reply = () => Promise.resolve(new Response(JSON.stringify({ deliveryId: "d1", [flag]: true }), { status: 202, headers: { "content-type": "application/json" } }));
    const { store, sim, notifier, calls } = setup([reply]);
    const events: string[] = [];
    store.on((e) => events.push(e.name));
    sim.deliverClientEmail();
    await notifier.idle();
    assert.equal(calls.length, 1, "not retried");
    assert.match(store.state.activity.at(-1)!.text, /Desk Manager didn't start/);
    assert.ok(events.includes("webhook_failed"));
  }
});

test("a repeated voice log reuses its key; a new verdict gets a new one", async () => {
  const { store, desk, sim, notifier, calls } = setup();
  const email = sim.deliverClientEmail();
  const { req_id } = desk.createRequirement({
    actor: "Desk Manager", source_email_id: email.id, title: "Senior Java Developer", client: "Contoso Health",
    client_contact: "dana.whitfield@contosohealth.example.com", location: "Dallas, TX", work_mode: "hybrid", rate: 68,
    employment_type: "C2C", skills: ["Spring Boot", "AWS", "Kafka"], min_years: 8, jd: "Spring Boot, AWS, Kafka. 8+ years.",
  });
  const kiran = candidateId(store, "Kiran Rao");
  desk.addCandidatesToRequirement({ actor: "Job Board Sourcer", req_id, candidate_ids: [kiran], source: "dice" });
  const log = (verdict: "pass" | "hold") => desk.logScreenResult({ actor: "Phone Screener", req_id, candidate_id: kiran, channel: "voice", interested: true,
    availability: "Nov 10", notice_period: "2 weeks", pay_expectation: "$66/hr", location_ok: true, work_auth_confirmed: true, notes: "", verdict });
  (store as { now: () => number }).now = () => 1_000_500;
  log("hold");
  (store as { now: () => number }).now = () => 1_000_900;
  log("pass");
  (store as { now: () => number }).now = () => 1_001_300;
  log("pass");
  await notifier.idle();
  const keys = calls.filter((c) => header(c, "x-event-type") === "screen.logged").map((c) => header(c, "idempotency-key"));
  assert.equal(keys.length, 3);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[1], keys[2]);
});

test("picks up a webhook address written after start", async () => {
  const store = makeStore();
  const desk = createDesk(store);
  const sim = createSim(store, desk);
  const f = fakeFetch([ok]);
  let cfg: { url: string | null; secret: string | null } = { url: null, secret: null };
  const notifier = createWebhookNotifier(store, () => cfg, f.impl, { retryDelaysMs: [0, 0] });
  cfg = { url: URL_, secret: null };
  sim.deliverClientEmail();
  await notifier.idle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, URL_);
});
