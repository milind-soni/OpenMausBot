import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { createDesk, DeskError } from "../src/desk.ts";
import { sendSubmissionInput } from "../src/schemas.ts";
import type { Store } from "../src/store.ts";
import { candidateId, clock, makeStore } from "./helpers.ts";

const JAVA_REQ = {
  title: "Senior Java Developer", client: "Contoso Health", client_contact: "dana.whitfield@contosohealth.example.com",
  location: "Dallas, TX", work_mode: "hybrid" as const, rate: 68, employment_type: "C2C" as const,
  skills: ["Spring Boot", "AWS", "Kafka"], min_years: 8, jd: "Spring Boot, AWS, Kafka. 8+ years.",
};

function withHeroReq() {
  const c = clock();
  const store = makeStore(c.now);
  const desk = createDesk(store);
  const email = desk.receiveEmail(store.state.script.heroClientEmail);
  c.advance(60_000);
  const { req_id } = desk.createRequirement({ actor: "Desk Manager", source_email_id: email.id, ...JAVA_REQ });
  return { c, store, desk, email, reqId: req_id };
}

/** Put the top 3 on REQ-1042 with complete paperwork, ready to draft. */
function readyToSubmit() {
  const ctx = withHeroReq();
  const { store, desk, reqId } = ctx;
  const ids = ["Kiran Rao", "Ana Souza", "Marcus Lee"].map((n) => candidateId(store, n));
  desk.addCandidatesToRequirement({ actor: "Job Board Sourcer", req_id: reqId, candidate_ids: ids, source: "dice" });
  for (const id of ids) {
    const docs = store.state.candidates.find((c) => c.id === id)!.workAuthDocs.map((d) => d.url);
    desk.recordPaperwork({ actor: "Paperwork", req_id: reqId, candidate_id: id, rtr_signed: true, rate_confirmed: 66, nda_signed: true, work_auth_doc_urls: docs });
  }
  return { ...ctx, ids };
}

const snapshot = (store: Store) => JSON.stringify(store.state);

test("create_requirement makes REQ-1042 with clock = email time", () => {
  const { store, email, reqId } = withHeroReq();
  assert.equal(reqId, "REQ-1042");
  const req = store.state.requirements.find((r) => r.id === "REQ-1042")!;
  assert.equal(req.receivedAt, email.at);
  assert.equal(req.sourceEmailId, email.id);
});

test("create_requirement is idempotent per email", () => {
  const { store, desk, email } = withHeroReq();
  const before = store.state.requirements.length;
  const again = desk.createRequirement({ actor: "Desk Manager", source_email_id: email.id, ...JAVA_REQ });
  assert.deepEqual(again, { req_id: "REQ-1042", existing: true });
  assert.equal(store.state.requirements.length, before);
});

test("unknown ids are refused and nothing changes", () => {
  const { store, desk, reqId } = withHeroReq();
  const kiran = candidateId(store, "Kiran Rao");
  const before = snapshot(store);
  assert.throws(() => desk.moveCandidateStage({ actor: "Matcher", req_id: "REQ-9999", candidate_id: kiran, stage: "matched" }),
    (e: unknown) => e instanceof DeskError && e.message.includes("REQ-9999"));
  assert.throws(() => desk.scoreCandidates({ actor: "Matcher", req_id: reqId, scores: [{ candidate_id: kiran, score: 95, reasons: "fit" }] }),
    (e: unknown) => e instanceof DeskError && e.message.includes(kiran) && e.message.includes(reqId));
  assert.throws(() => desk.addCandidatesToRequirement({ actor: "Job Board Sourcer", req_id: reqId, candidate_ids: [kiran, "CAN-9999"], source: "dice" }),
    (e: unknown) => e instanceof DeskError && e.message.includes("CAN-9999"));
  assert.throws(() => desk.sendSubmission({ actor: "Submission Writer", submission_id: "SUB-9999", approval_quote: "Approve all" }),
    (e: unknown) => e instanceof DeskError && e.message.includes("SUB-9999"));
  assert.equal(snapshot(store), before);
});

test("search_candidates with req_id ranks the top 3 first", () => {
  const { desk, reqId } = withHeroReq();
  const res = desk.searchCandidates({ query: "java AND kafka", req_id: reqId });
  assert.deepEqual(res.results.slice(0, 3).map((r) => r.name).sort(), ["Ana Souza", "Kiran Rao", "Marcus Lee"]);
  assert.equal(typeof res.results[0]!.keywordScore, "number");
  assert.ok(res.total >= res.results.length);
});

test("search_candidates turns a malformed query into a DeskError", () => {
  const { desk } = withHeroReq();
  assert.throws(() => desk.searchCandidates({ query: "(java AND kafka" }), (e: unknown) => e instanceof DeskError && /Bad Boolean query/.test(e.message));
});

test("score_candidates moves 80+ to matched only", () => {
  const { store, desk, reqId } = withHeroReq();
  const [a, b] = ["Kiran Rao", "Ana Souza"].map((n) => candidateId(store, n));
  desk.addCandidatesToRequirement({ actor: "Job Board Sourcer", req_id: reqId, candidate_ids: [a!, b!], source: "dice" });
  const res = desk.scoreCandidates({ actor: "Matcher", req_id: reqId, scores: [{ candidate_id: a!, score: 94, reasons: "healthcare" }, { candidate_id: b!, score: 79, reasons: "rate" }] });
  assert.deepEqual(res, { scored: 2, matched: 1 });
  const stage = (id: string) => store.state.pipeline.find((p) => p.reqId === reqId && p.candidateId === id)!.stage;
  assert.equal(stage(a!), "matched");
  assert.equal(stage(b!), "sourced");
});

test("send_vendor_mail is idempotent per req", () => {
  const { store, desk, reqId } = withHeroReq();
  const events: string[] = [];
  store.on((e) => events.push(e.name));
  const first = desk.sendVendorMail({ actor: "Vendor Bench", req_id: reqId, vendor_ids: ["all"], subject: "Sr Java", body: "Bench?" });
  const second = desk.sendVendorMail({ actor: "Vendor Bench", req_id: reqId, vendor_ids: ["all"], subject: "Sr Java", body: "Bench?" });
  assert.equal(second.email_id, first.email_id);
  assert.equal(second.existing, true);
  assert.equal(store.state.emails.filter((e) => e.kind === "vendor_mail").length, 1);
  assert.equal(events.filter((n) => n === "vendor_mail_sent").length, 1);
  assert.equal(first.recipients, 25);
});

test("vendor_mail_sent carries the expanded vendor ids", () => {
  const { store, desk, reqId } = withHeroReq();
  let detail: Record<string, unknown> | undefined;
  store.on((e) => { if (e.name === "vendor_mail_sent") detail = e.detail; });
  desk.sendVendorMail({ actor: "Vendor Bench", req_id: reqId, vendor_ids: ["VEN-02", "VEN-05"], subject: "Sr Java", body: "Bench?" });
  assert.deepEqual(detail, { vendorIds: ["VEN-02", "VEN-05"] });
});

test("import_vendor_resumes adds the reply's consultants as sourced", () => {
  const { store, desk, reqId } = withHeroReq();
  const reply = store.state.script.vendorReplies[0]!;
  const email = desk.receiveEmail({ kind: "vendor_reply", from: "bench@x.example.com", to: ["desk@recruitingdesk.example.com"], subject: "Re: Sr Java", body: reply.body, reqId, vendorId: reply.vendorId, attachments: [] });
  const res = desk.importVendorResumes({ actor: "Vendor Bench", req_id: reqId, email_id: email.id });
  assert.deepEqual(res.candidate_ids, reply.consultants.map((c) => c.id));
  for (const id of res.candidate_ids) {
    assert.ok(store.state.candidates.some((c) => c.id === id));
    assert.equal(store.state.pipeline.find((p) => p.reqId === reqId && p.candidateId === id)?.stage, "sourced");
  }
  assert.throws(() => desk.importVendorResumes({ actor: "Vendor Bench", req_id: reqId, email_id: store.state.emails[0]!.id }), DeskError);
});

test("draft_submission lists missing fields", () => {
  const { store, desk, reqId } = withHeroReq();
  const someone = store.state.candidates.find((c) => !["Kiran Rao", "Ana Souza", "Marcus Lee"].includes(c.name))!;
  someone.linkedin = "";
  desk.addCandidatesToRequirement({ actor: "Job Board Sourcer", req_id: reqId, candidate_ids: [someone.id], source: "dice" });
  assert.throws(() => desk.draftSubmission({ actor: "Submission Writer", req_id: reqId, candidate_id: someone.id, subject: "Submission", body: "Why this candidate fits.", bill_rate: 68 }),
    (e: unknown) => e instanceof DeskError && e.message.includes("paperwork") && e.message.includes("LinkedIn"));
});

test("draft_submission attaches resume and work-auth docs, addressed to the client", () => {
  const { store, desk, reqId, ids } = readyToSubmit();
  const kiran = ids[0]!;
  const { submission_id } = desk.draftSubmission({ actor: "Submission Writer", req_id: reqId, candidate_id: kiran, subject: "Submission: Kiran Rao", body: "Why Kiran fits the role.", bill_rate: 68 });
  const sub = store.state.submissions.find((s) => s.id === submission_id)!;
  assert.equal(sub.to, "dana.whitfield@contosohealth.example.com");
  assert.equal(sub.status, "draft");
  const names = sub.attachments.map((a) => a.name);
  assert.ok(names.some((n) => n.includes("resume")));
  assert.ok(names.filter((n) => n.includes("SAMPLE")).length >= 2);
});

test("send_submission stops the clock once and is idempotent", () => {
  const { c, store, desk, reqId, ids } = readyToSubmit();
  const draft = (id: string) => desk.draftSubmission({ actor: "Submission Writer", req_id: reqId, candidate_id: id, subject: "Submission", body: "Why this candidate fits.", bill_rate: 68 }).submission_id;
  const a = draft(ids[1]!);
  const b = draft(ids[2]!);
  c.advance(600_000);
  desk.sendSubmission({ actor: "Submission Writer", submission_id: a, approval_quote: "Approve all" });
  const req = () => store.state.requirements.find((r) => r.id === reqId)!;
  const stoppedAt = req().firstSubmittedAt;
  assert.equal(stoppedAt, c.now());
  assert.equal(store.state.pipeline.find((p) => p.reqId === reqId && p.candidateId === ids[1])!.stage, "submitted");
  const again = desk.sendSubmission({ actor: "Submission Writer", submission_id: a, approval_quote: "Approve all" });
  assert.equal(again.existing, true);
  assert.equal(store.state.emails.filter((e) => e.kind === "submission").length, 1);
  c.advance(30_000);
  desk.sendSubmission({ actor: "Submission Writer", submission_id: b, approval_quote: "Approve all" });
  assert.equal(req().firstSubmittedAt, stoppedAt);
  assert.equal(store.state.submissions.find((s) => s.id === a)!.approvalQuote, "Approve all");
});

test("send_submission requires approval_quote", () => {
  assert.equal(sendSubmissionInput.safeParse({ actor: "Submission Writer", submission_id: "SUB-0001", approval_quote: "" }).success, false);
  assert.equal(sendSubmissionInput.safeParse({ actor: "Submission Writer", submission_id: "SUB-0001", approval_quote: "Approve all" }).success, true);
});

test("every write logs activity with the actor", () => {
  const { store, desk, reqId } = withHeroReq();
  desk.postJob({ actor: "Job Board Sourcer", req_id: reqId, boards: ["dice", "linkedin"] });
  const last = store.state.activity.at(-1)!;
  assert.equal(last.actor, "Job Board Sourcer");
  assert.equal(last.reqId, reqId);
  assert.deepEqual(store.state.requirements.find((r) => r.id === reqId)!.postedOn, ["dice", "linkedin"]);
});

test("log_screen_result moves a pass to screened and reports the channel", () => {
  const { store, desk, reqId } = withHeroReq();
  const kiran = candidateId(store, "Kiran Rao");
  desk.addCandidatesToRequirement({ actor: "Job Board Sourcer", req_id: reqId, candidate_ids: [kiran], source: "dice" });
  let detail: Record<string, unknown> | undefined;
  store.on((e) => { if (e.name === "screen_logged") detail = e.detail; });
  desk.logScreenResult({ actor: "Phone Screener", req_id: reqId, candidate_id: kiran, channel: "voice", interested: true, availability: "Nov 10",
    notice_period: "2 weeks", pay_expectation: "$66/hr C2C", location_ok: true, work_auth_confirmed: true, notes: "Prefers Mon/Tue remote", verdict: "pass" });
  assert.equal(store.state.pipeline.find((p) => p.reqId === reqId && p.candidateId === kiran)!.stage, "screened");
  assert.deepEqual(detail, { channel: "voice", verdict: "pass" });
});

test("stages only move forward on screen, paperwork and submission", () => {
  const { store, desk, reqId, ids } = readyToSubmit();
  const ana = ids[1]!;
  assert.equal(store.state.pipeline.find((p) => p.reqId === reqId && p.candidateId === ana)!.stage, "rtr");
  desk.logScreenResult({ actor: "Phone Screener", req_id: reqId, candidate_id: ana, channel: "text", interested: true, availability: "2 weeks",
    notice_period: "2 weeks", pay_expectation: "$65/hr", location_ok: true, work_auth_confirmed: true, notes: "", verdict: "pass" });
  assert.equal(store.state.pipeline.find((p) => p.reqId === reqId && p.candidateId === ana)!.stage, "rtr");
});

test("wait_for_replies resolves on arrival and on timeout", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { store, desk, reqId, ids } = readyToSubmit();
    const [kiran, ana] = ids;
    for (const id of [kiran!, ana!]) desk.sendCandidateMessage({ actor: "Phone Screener", req_id: reqId, candidate_id: id, kind: "text_screen", subject: "Quick screen", body: "Q1..Q5" });
    const pending = desk.waitForReplies({ candidate_ids: [ana!], kind: "text_screen_reply", timeout_seconds: 60 });
    const reply = desk.receiveEmail({ kind: "text_screen_reply", from: "ana.souza@mail.example.com", to: ["desk@recruitingdesk.example.com"], subject: "Re: Quick screen", body: "Yes", reqId, candidateId: ana!, attachments: [] });
    store.emit({ name: "candidate_reply_received", candidateId: ana!, emailId: reply.id });
    const done = await pending;
    assert.deepEqual(done.missing, []);
    assert.equal(done.arrived[0]!.id, reply.id);

    const timeout = desk.waitForReplies({ candidate_ids: [kiran!], kind: "text_screen_reply", timeout_seconds: 5 });
    mock.timers.tick(5_000);
    assert.deepEqual((await timeout).missing, [kiran]);

    await assert.rejects(desk.waitForReplies({ candidate_ids: [ids[2]!], kind: "rtr_reply" }), DeskError);
  } finally {
    mock.timers.reset();
  }
});

test("interview, onboarding and timesheet flow", () => {
  const { store, desk, reqId, ids } = readyToSubmit();
  const ana = ids[1]!;
  const { interview_id } = desk.scheduleInterview({ actor: "Interview Coordinator", req_id: reqId, candidate_id: ana, round: 1, when: "Tue Oct 27, 2 PM CT", interviewers: "Architect" });
  assert.equal(store.state.pipeline.find((p) => p.reqId === reqId && p.candidateId === ana)!.stage, "interview");
  assert.equal(store.state.emails.at(-1)!.kind, "interview");
  desk.logInterviewFeedback({ actor: "Interview Coordinator", interview_id, feedback: "Strong", outcome: "offer" });
  assert.equal(store.state.pipeline.find((p) => p.reqId === reqId && p.candidateId === ana)!.stage, "offer");
  desk.updateOnboarding({ actor: "Onboarding", candidate_id: ana, path: "C2C", bgv: "in_progress", laptop_tracking: "FedEx 1234" });
  assert.equal(store.state.pipeline.find((p) => p.reqId === reqId && p.candidateId === ana)!.stage, "onboarding");
  desk.requestTimesheet({ actor: "Timesheets", candidate_id: ana, month: "2026-10" });
  desk.recordTimesheet({ actor: "Timesheets", candidate_id: ana, month: "2026-10", hours: 168, status: "approved" });
  assert.deepEqual(store.state.timesheets.find((t) => t.candidateId === ana && t.month === "2026-10"), { candidateId: ana, month: "2026-10", hours: 168, status: "approved" });
  assert.throws(() => desk.updateOnboarding({ actor: "Onboarding", candidate_id: ids[0]!, bgv: "clear" }), DeskError);
});

test("writes persist to the state file", () => {
  const { store, desk, reqId } = withHeroReq();
  desk.postJob({ actor: "Job Board Sourcer", req_id: reqId, boards: ["monster"] });
  assert.ok(JSON.stringify(store.state).includes('"monster"'));
});

test("get_candidate includes interviews, onboarding and timesheets", () => {
  const { store, desk } = withHeroReq();
  const interviewed = store.state.interviews[0]!.candidateId;
  const onboarded = store.state.onboarding.find((o) => o.path === "W2")!.candidateId;
  const a = desk.getCandidate({ candidate_id: interviewed });
  assert.ok(a.interviews.length >= 1 && a.interviews[0]!.id.startsWith("INT-"));
  const b = desk.getCandidate({ candidate_id: onboarded });
  assert.equal(b.onboarding[0]!.path, "W2");
  assert.ok(b.timesheets.length >= 2);
});

test("get_requirement reports time_to_submit and existing submissions", () => {
  const { c, desk, reqId, ids } = readyToSubmit();
  assert.equal(desk.getRequirement({ req_id: reqId }).time_to_submit, null);
  const { submission_id } = desk.draftSubmission({ actor: "Submission Writer", req_id: reqId, candidate_id: ids[1]!, subject: "Submission", body: "Why this candidate fits.", bill_rate: 68 });
  let r = desk.getRequirement({ req_id: reqId });
  assert.deepEqual(r.submissions, [{ submission_id, candidate_id: ids[1], name: "Ana Souza", status: "draft" }]);
  c.advance(12 * 60_000 + 5_000); // 60 s after the email when created, now 13:05 after it
  desk.sendSubmission({ actor: "Submission Writer", submission_id, approval_quote: "Approve all" });
  r = desk.getRequirement({ req_id: reqId });
  assert.equal(r.time_to_submit, "13:05");
  assert.equal(r.submissions[0]!.status, "sent");
});

test("record_paperwork accepts document names or urls and refuses unknown documents", () => {
  const { store, desk, reqId } = withHeroReq();
  const ana = store.state.candidates.find((x) => x.name === "Ana Souza")!;
  desk.addCandidatesToRequirement({ actor: "Job Board Sourcer", req_id: reqId, candidate_ids: [ana.id], source: "dice" });
  const before = JSON.stringify(store.state.paperwork);
  assert.throws(() => desk.recordPaperwork({ actor: "Paperwork", req_id: reqId, candidate_id: ana.id, rtr_signed: true, rate_confirmed: 65, nda_signed: true, work_auth_doc_urls: ["passport.pdf"] }),
    (e: unknown) => e instanceof DeskError && e.message.includes("passport.pdf") && e.message.includes(ana.workAuthDocs[0]!.url));
  assert.equal(JSON.stringify(store.state.paperwork), before);
  desk.recordPaperwork({ actor: "Paperwork", req_id: reqId, candidate_id: ana.id, rtr_signed: true, rate_confirmed: 65, nda_signed: true,
    work_auth_doc_urls: [ana.workAuthDocs[0]!.name, ana.workAuthDocs[1]!.url] });
  assert.deepEqual(store.state.paperwork.at(-1)!.workAuthDocs, ana.workAuthDocs);
});

test("move_candidate_stage refuses Submitted so nothing reaches it without approval", () => {
  const { store, desk, reqId } = withHeroReq();
  const kiran = candidateId(store, "Kiran Rao");
  desk.addCandidatesToRequirement({ actor: "Job Board Sourcer", req_id: reqId, candidate_ids: [kiran], source: "dice" });
  assert.throws(() => desk.moveCandidateStage({ actor: "Matcher", req_id: reqId, candidate_id: kiran, stage: "submitted" }),
    (e: unknown) => e instanceof DeskError && /send_submission/.test(e.message));
  assert.equal(store.state.pipeline.find((p) => p.reqId === reqId && p.candidateId === kiran)!.stage, "sourced");
});
