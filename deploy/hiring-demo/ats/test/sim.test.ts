import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createDesk, DeskError } from "../src/desk.ts";
import { createSim } from "../src/sim.ts";
import { createStore } from "../src/store.ts";
import { candidateId, seedFiles } from "./helpers.ts";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

const NOW = () => 1_800_000_000_000;

function setup(files = seedFiles()) {
  const store = createStore({ ...files, now: NOW });
  const desk = createDesk(store);
  const sim = createSim(store, desk);
  return { files, store, desk, sim };
}

function heroReq(ctx: ReturnType<typeof setup>) {
  const email = ctx.sim.deliverClientEmail();
  const { req_id } = ctx.desk.createRequirement({
    actor: "Desk Manager", source_email_id: email.id, title: "Senior Java Developer", client: "Contoso Health",
    client_contact: "dana.whitfield@contosohealth.example.com", location: "Dallas, TX", work_mode: "hybrid", rate: 68,
    employment_type: "C2C", skills: ["Spring Boot", "AWS", "Kafka"], min_years: 8, jd: "Spring Boot, AWS, Kafka. 8+ years.",
  });
  return req_id;
}

const vendorReplies = (ctx: ReturnType<typeof setup>) => ctx.store.state.emails.filter((e) => e.kind === "vendor_reply");

test("vendor mail produces 6 replies within 40s", () => {
  const ctx = setup();
  const reqId = heroReq(ctx);
  ctx.desk.sendVendorMail({ actor: "Vendor Bench", req_id: reqId, vendor_ids: ["all"], subject: "Sr Java - Dallas", body: "Any bench consultants?" });
  mock.timers.tick(7_999);
  assert.equal(vendorReplies(ctx).length, 0);
  mock.timers.tick(32_001);
  const replies = vendorReplies(ctx);
  assert.equal(replies.length, 6);
  for (const r of replies) {
    assert.equal(r.reqId, reqId);
    assert.ok(r.vendorId);
    assert.ok(r.attachments.length >= 1);
  }
  assert.equal(ctx.store.state.pending.length, 0);
});

test("only mailed vendors reply", () => {
  const ctx = setup();
  const reqId = heroReq(ctx);
  const first = ctx.store.state.script.vendorReplies[0]!.vendorId;
  ctx.desk.sendVendorMail({ actor: "Vendor Bench", req_id: reqId, vendor_ids: [first, "VEN-01"], subject: "Sr Java", body: "Bench?" });
  mock.timers.tick(40_000);
  assert.deepEqual(vendorReplies(ctx).map((r) => r.vendorId), [first]);
});

test("text screen reply only for candidates with answers", () => {
  const ctx = setup();
  const reqId = heroReq(ctx);
  const [ana, kiran] = ["Ana Souza", "Kiran Rao"].map((n) => candidateId(ctx.store, n));
  ctx.desk.addCandidatesToRequirement({ actor: "Job Board Sourcer", req_id: reqId, candidate_ids: [ana!, kiran!], source: "dice" });
  const events: string[] = [];
  ctx.store.on((e) => events.push(e.name));
  ctx.desk.sendCandidateMessage({ actor: "Phone Screener", req_id: reqId, candidate_id: ana!, kind: "text_screen", subject: "Quick screen", body: "5 quick questions" });
  ctx.desk.sendCandidateMessage({ actor: "Phone Screener", req_id: reqId, candidate_id: kiran!, kind: "text_screen", subject: "Quick screen", body: "5 quick questions" });
  ctx.desk.sendCandidateMessage({ actor: "Phone Screener", req_id: reqId, candidate_id: kiran!, kind: "missed_call", subject: "Missed you", body: "Call back please" });
  mock.timers.tick(15_000);
  const replies = ctx.store.state.emails.filter((e) => e.kind === "text_screen_reply");
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.candidateId, ana);
  assert.match(replies[0]!.body, /\$65\/hr C2C/);
  assert.ok(events.includes("candidate_reply_received"));
  mock.timers.tick(60_000);
  assert.equal(ctx.store.state.emails.filter((e) => e.direction === "in" && e.candidateId === kiran).length, 0);
});

test("rtr reply attaches SAMPLE docs", () => {
  const ctx = setup();
  const reqId = heroReq(ctx);
  const ana = candidateId(ctx.store, "Ana Souza");
  ctx.desk.addCandidatesToRequirement({ actor: "Job Board Sourcer", req_id: reqId, candidate_ids: [ana], source: "dice" });
  ctx.desk.sendCandidateMessage({ actor: "Paperwork", req_id: reqId, candidate_id: ana, kind: "rtr", subject: "RTR for REQ-1042", body: "Please confirm" });
  mock.timers.tick(12_000);
  const reply = ctx.store.state.emails.find((e) => e.kind === "rtr_reply")!;
  assert.ok(reply.attachments.length >= 2);
  for (const a of reply.attachments) assert.match(a.name, /SAMPLE/);
  assert.match(reply.body, /REQ-1042/);
  assert.match(reply.body, /NDA signed/);
});

test("timesheet request gets hours back", () => {
  const ctx = setup();
  const onboarded = ctx.store.state.onboarding[0]!.candidateId;
  ctx.desk.requestTimesheet({ actor: "Timesheets", candidate_id: onboarded, month: "2026-10" });
  mock.timers.tick(10_000);
  const reply = ctx.store.state.emails.find((e) => e.kind === "timesheet_reply")!;
  assert.equal(reply.candidateId, onboarded);
  assert.match(reply.body, /168/);
});

test("client email only once until reset", () => {
  const ctx = setup();
  ctx.sim.deliverClientEmail();
  assert.throws(() => ctx.sim.deliverClientEmail(), DeskError);
  ctx.store.reset();
  const again = ctx.sim.deliverClientEmail();
  assert.equal(again.kind, "client_requirement");
});

test("client email emits client_email_received", () => {
  const ctx = setup();
  const seen: { name: string; emailId?: string }[] = [];
  ctx.store.on((e) => seen.push(e));
  const email = ctx.sim.deliverClientEmail();
  assert.deepEqual(seen.find((e) => e.name === "client_email_received")?.emailId, email.id);
});

test("morning events deliver feedback and offer emails once", () => {
  const ctx = setup();
  let detail: Record<string, unknown> | undefined;
  ctx.store.on((e) => { if (e.name === "morning_events") detail = e.detail; });
  const emails = ctx.sim.deliverMorningEvents();
  assert.deepEqual(emails.map((e) => e.kind), ["client_feedback", "offer_accepted"]);
  assert.deepEqual(detail, { feedbackEmailId: emails[0]!.id, offerAcceptedEmailId: emails[1]!.id, timesheetMonth: "2026-10" });
  assert.throws(() => ctx.sim.deliverMorningEvents(), DeskError);
});

test("reset cancels pending replies", () => {
  const ctx = setup();
  const reqId = heroReq(ctx);
  ctx.desk.sendVendorMail({ actor: "Vendor Bench", req_id: reqId, vendor_ids: ["all"], subject: "Sr Java", body: "Bench?" });
  mock.timers.tick(5_000);
  ctx.store.reset();
  mock.timers.tick(60_000);
  assert.equal(vendorReplies(ctx).length, 0);
  assert.equal(ctx.store.state.pending.length, 0);
});

test("restart re-arms pending replies", () => {
  const first = setup();
  const reqId = heroReq(first);
  first.desk.sendVendorMail({ actor: "Vendor Bench", req_id: reqId, vendor_ids: ["all"], subject: "Sr Java", body: "Bench?" });
  mock.timers.tick(10_000);
  first.sim.stop(); // the process dies
  const second = setup(first.files);
  const before = vendorReplies(second).length;
  assert.equal(before, 1);
  mock.timers.tick(40_000);
  const replies = vendorReplies(second);
  assert.equal(replies.length, 6);
  assert.equal(new Set(replies.map((r) => r.vendorId)).size, 6);
});

test("inbound replies show in the activity feed", () => {
  const ctx = setup();
  const reqId = heroReq(ctx);
  const reply = ctx.store.state.script.vendorReplies[0]!;
  const vendor = ctx.store.state.vendors.find((v) => v.id === reply.vendorId)!;
  ctx.desk.sendVendorMail({ actor: "Vendor Bench", req_id: reqId, vendor_ids: [reply.vendorId], subject: "Sr Java", body: "Bench?" });
  mock.timers.tick(40_000);
  const last = ctx.store.state.activity.at(-1)!;
  assert.equal(last.actor, "Inbox");
  assert.match(last.text, new RegExp(vendor.name));
  assert.match(last.text, new RegExp(`${reply.consultants.length} consultant`));
  assert.equal(last.reqId, reqId);
});
