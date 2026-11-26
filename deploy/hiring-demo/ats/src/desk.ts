// Every desk operation the bots can perform. Writes validate ids, change state, log activity with the actor,
// save, then emit one event. Errors are DeskError with a sentence a bot can act on.
import type { z } from "zod";

import { keywordScore, matchesQuery } from "./rank.ts";
import { TOOL_SCHEMAS, type ToolArgs, type ToolName } from "./schemas.ts";
import type { Store } from "./store.ts";
import {
  STAGE_LABELS, STAGES, type Attachment, type BotName, type Candidate, type DeskEvent, type Email, type EmailDraft, type PipelineEntry,
  type Requirement, type Stage,
} from "./types.ts";

export class DeskError extends Error {}

export const DESK_ADDRESS = "desk@recruitingdesk.example.com";

const BOARD_LABELS: Record<string, string> = { dice: "Dice", monster: "Monster", linkedin: "LinkedIn" };
const emailNum = (id: string) => Number(id.replace(/\D/g, ""));
function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}
const firstName = (c: Candidate) => c.name.split(" ")[0];

function parse<N extends ToolName>(name: N, args: unknown): z.output<(typeof TOOL_SCHEMAS)[N]> {
  const result = TOOL_SCHEMAS[name].safeParse(args ?? {});
  if (!result.success) {
    throw new DeskError(`Invalid ${name} input: ${result.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`);
  }
  return result.data as z.output<(typeof TOOL_SCHEMAS)[N]>;
}

export function createDesk(store: Store) {
  const s = () => store.state;

  // ---- lookups -------------------------------------------------------------------------------------------------
  function req(id: string): Requirement {
    const r = s().requirements.find((x) => x.id === id);
    if (!r) throw new DeskError(`Requirement ${id} not found. Use get_desk_overview to list requirements.`);
    return r;
  }
  function candidate(id: string): Candidate {
    const c = s().candidates.find((x) => x.id === id);
    if (!c) throw new DeskError(`Candidate ${id} not found. Use search_candidates or list_pipeline to find candidate ids.`);
    return c;
  }
  function entry(reqId: string, candidateId: string): PipelineEntry {
    req(reqId);
    candidate(candidateId);
    const e = s().pipeline.find((p) => p.reqId === reqId && p.candidateId === candidateId);
    if (!e) throw new DeskError(`Candidate ${candidateId} is not on ${reqId}. Use list_pipeline to see who is.`);
    return e;
  }
  function email(id: string): Email {
    const e = s().emails.find((x) => x.id === id);
    if (!e) throw new DeskError(`Email ${id} not found. Use list_inbox or list_outbox.`);
    return e;
  }
  function counts(reqId: string): Record<Stage, number> {
    const out = Object.fromEntries(STAGES.map((st) => [st, 0])) as Record<Stage, number>;
    for (const p of s().pipeline) if (p.reqId === reqId) out[p.stage]++;
    return out;
  }

  // ---- write helpers -------------------------------------------------------------------------------------------
  function advance(e: PipelineEntry, stage: Stage): boolean {
    if (STAGES.indexOf(stage) <= STAGES.indexOf(e.stage)) return false;
    e.stage = stage;
    e.updatedAt = store.now();
    return true;
  }
  function finish(actor: string, text: string, event: Omit<DeskEvent, "at">) {
    store.log(actor, text, { ...(event.reqId ? { reqId: event.reqId } : {}), ...(event.candidateId ? { candidateId: event.candidateId } : {}) });
    store.save();
    store.emit(event);
  }
  function addEmail(direction: "in" | "out", draft: EmailDraft): Email {
    const e: Email = { ...draft, id: store.nextId("EM"), direction, at: store.now() };
    s().emails.push(e);
    return e;
  }
  function send(actor: BotName, draft: Omit<EmailDraft, "actor" | "from">): Email {
    return addEmail("out", { ...draft, from: DESK_ADDRESS, actor });
  }

  const desk = {
    /** Inbound mail from the simulator or a demo trigger. Not a bot tool. */
    receiveEmail(draft: EmailDraft): Email {
      const e = addEmail("in", draft);
      store.save();
      return e;
    },

    // ---- reads -------------------------------------------------------------------------------------------------
    getDeskOverview(_args: ToolArgs<"get_desk_overview"> = {}) {
      return {
        requirements: s().requirements.filter((r) => r.status === "open").map((r) => ({
          id: r.id, title: r.title, client: r.client, location: r.location, rate: r.rate, receivedAt: r.receivedAt,
          firstSubmittedAt: r.firstSubmittedAt ?? null, counts: counts(r.id),
        })),
      };
    },
    getRequirement(args: ToolArgs<"get_requirement">) {
      const a = parse("get_requirement", args);
      const r = req(a.req_id);
      return {
        ...r,
        counts: counts(r.id),
        time_to_submit: r.firstSubmittedAt ? clockText(r.firstSubmittedAt - r.receivedAt) : null,
        submissions: s().submissions.filter((x) => x.reqId === r.id)
          .map((x) => ({ submission_id: x.id, candidate_id: x.candidateId, name: candidate(x.candidateId).name, status: x.status })),
      };
    },
    listPipeline(args: ToolArgs<"list_pipeline">) {
      const a = parse("list_pipeline", args);
      const r = req(a.req_id);
      let rows = s().pipeline.filter((p) => p.reqId === r.id && (!a.stage || p.stage === a.stage)).map((p) => {
        const c = candidate(p.candidateId);
        return {
          candidate_id: c.id, name: c.name, title: c.title, location: c.location, workAuth: c.workAuth, years: c.years,
          rateExpectation: c.rateExpectation, source: c.source, contactPreference: c.contactPreference, stage: p.stage,
          score: p.score ?? null, scoreReasons: p.scoreReasons ?? null, keywordScore: keywordScore(c, r),
          ...(a.include_resume ? { resume: c.resume.slice(0, 1500) } : {}),
        };
      });
      if (a.sort === "keyword") rows.sort((x, y) => y.keywordScore - x.keywordScore);
      else if (a.sort === "score") rows.sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
      else rows.sort((x, y) => STAGES.indexOf(y.stage) - STAGES.indexOf(x.stage) || y.keywordScore - x.keywordScore);
      const total = rows.length;
      rows = rows.slice(0, a.limit);
      return { req_id: r.id, total, entries: rows };
    },
    searchCandidates(args: ToolArgs<"search_candidates">) {
      const a = parse("search_candidates", args);
      const r = a.req_id ? req(a.req_id) : undefined;
      let hits: Candidate[];
      try {
        hits = s().candidates.filter((c) => matchesQuery(a.query, c));
      } catch (err) {
        throw new DeskError(`${(err as Error).message}. Example: "spring boot" AND (kafka OR aws) NOT intern`);
      }
      const onReq = new Set(r ? s().pipeline.filter((p) => p.reqId === r.id).map((p) => p.candidateId) : []);
      const rows = hits.map((c) => ({
        candidate_id: c.id, name: c.name, title: c.title, location: c.location, workAuth: c.workAuth, years: c.years, source: c.source,
        rateExpectation: c.rateExpectation, ...(r ? { keywordScore: keywordScore(c, r), on_requirement: onReq.has(c.id) } : {}),
      }));
      if (r) rows.sort((x, y) => (y.keywordScore ?? 0) - (x.keywordScore ?? 0));
      return { total: rows.length, results: rows.slice(0, a.limit) };
    },
    getCandidate(args: ToolArgs<"get_candidate">) {
      const a = parse("get_candidate", args);
      const c = candidate(a.candidate_id);
      return {
        ...c,
        pipeline: s().pipeline.filter((p) => p.candidateId === c.id),
        screens: s().screens.filter((x) => x.candidateId === c.id),
        paperwork: s().paperwork.filter((x) => x.candidateId === c.id),
        submissions: s().submissions.filter((x) => x.candidateId === c.id),
        interviews: s().interviews.filter((x) => x.candidateId === c.id),
        onboarding: s().onboarding.filter((x) => x.candidateId === c.id),
        timesheets: s().timesheets.filter((x) => x.candidateId === c.id),
        emails: s().emails.filter((x) => x.candidateId === c.id),
      };
    },
    listVendors(_args: ToolArgs<"list_vendors"> = {}) {
      return { vendors: s().vendors };
    },
    listInbox(args: ToolArgs<"list_inbox"> = {}) {
      const a = parse("list_inbox", args);
      const since = a.since_id ? emailNum(a.since_id) : 0;
      const emails = s().emails
        .filter((e) => e.direction === "in" && (!a.req_id || e.reqId === a.req_id) && (!a.kind || e.kind === a.kind) && emailNum(e.id) > since)
        .reverse()
        .slice(0, 50);
      return { emails };
    },
    getEmail(args: ToolArgs<"get_email">) {
      return email(parse("get_email", args).email_id);
    },
    listOutbox(args: ToolArgs<"list_outbox"> = {}) {
      const a = parse("list_outbox", args);
      return { emails: s().emails.filter((e) => e.direction === "out" && (!a.req_id || e.reqId === a.req_id)).reverse().slice(0, 50) };
    },
    async waitForReplies(args: ToolArgs<"wait_for_replies">) {
      const a = parse("wait_for_replies", args);
      const outboundKind = a.kind === "text_screen_reply" ? "text_screen" : "rtr";
      const sentAfter = new Map<string, number>();
      for (const id of a.candidate_ids) {
        candidate(id);
        const sent = s().emails.filter((e) => e.direction === "out" && e.kind === outboundKind && e.candidateId === id).at(-1);
        if (!sent) throw new DeskError(`No ${outboundKind} message was sent to ${id} yet. Use send_candidate_message first.`);
        sentAfter.set(id, emailNum(sent.id));
      }
      const check = () => {
        const arrived: Email[] = [];
        const missing: string[] = [];
        for (const id of a.candidate_ids) {
          const reply = s().emails.find((e) => e.direction === "in" && e.kind === a.kind && e.candidateId === id && emailNum(e.id) > sentAfter.get(id)!);
          if (reply) arrived.push(reply);
          else missing.push(id);
        }
        return { arrived, missing };
      };
      const now = check();
      if (now.missing.length === 0) return now;
      return new Promise<{ arrived: Email[]; missing: string[] }>((resolve) => {
        const done = (result: { arrived: Email[]; missing: string[] }) => {
          off();
          clearTimeout(timer);
          resolve(result);
        };
        const off = store.on((e) => {
          if (e.name !== "candidate_reply_received" && e.name !== "reset") return;
          const result = check();
          if (result.missing.length === 0) done(result);
        });
        const timer = setTimeout(() => done(check()), a.timeout_seconds * 1000);
      });
    },

    // ---- writes ------------------------------------------------------------------------------------------------
    createRequirement(args: ToolArgs<"create_requirement">) {
      const a = parse("create_requirement", args);
      const source = email(a.source_email_id);
      const existing = s().requirements.find((r) => r.sourceEmailId === source.id);
      if (existing) return { req_id: existing.id, existing: true };
      const r: Requirement = {
        id: store.nextId("REQ"), title: a.title, client: a.client, clientContact: a.client_contact, location: a.location, workMode: a.work_mode,
        rate: a.rate, employmentType: a.employment_type, skills: a.skills, minYears: a.min_years, jd: a.jd, status: "open",
        receivedAt: source.at, postedOn: [], sourceEmailId: source.id,
      };
      s().requirements.push(r);
      source.reqId = r.id;
      finish(a.actor, `Created ${r.id} ${r.title} (${r.client}, ${r.location}, $${r.rate}/hr ${r.employmentType}) from the client email`,
        { name: "requirement_created", reqId: r.id, emailId: source.id });
      return { req_id: r.id };
    },
    postJob(args: ToolArgs<"post_job">) {
      const a = parse("post_job", args);
      const r = req(a.req_id);
      for (const b of a.boards) if (!r.postedOn.includes(b)) r.postedOn.push(b);
      finish(a.actor, `Posted ${r.id} to ${a.boards.map((b) => BOARD_LABELS[b]).join(", ")}`, { name: "job_posted", reqId: r.id });
      return { req_id: r.id, posted_on: r.postedOn };
    },
    addCandidatesToRequirement(args: ToolArgs<"add_candidates_to_requirement">) {
      const a = parse("add_candidates_to_requirement", args);
      const r = req(a.req_id);
      for (const id of a.candidate_ids) candidate(id);
      const onReq = new Set(s().pipeline.filter((p) => p.reqId === r.id).map((p) => p.candidateId));
      let added = 0;
      for (const id of new Set(a.candidate_ids)) {
        if (onReq.has(id)) continue;
        s().pipeline.push({ reqId: r.id, candidateId: id, stage: "sourced", updatedAt: store.now() });
        added++;
      }
      const skipped = a.candidate_ids.length - added;
      finish(a.actor, `Added ${added} candidates to ${r.id} from ${BOARD_LABELS[a.source] ?? a.source}`,
        { name: "candidates_added", reqId: r.id, detail: { count: added, source: a.source } });
      return { added, skipped };
    },
    sendVendorMail(args: ToolArgs<"send_vendor_mail">) {
      const a = parse("send_vendor_mail", args);
      const r = req(a.req_id);
      const prior = s().emails.find((e) => e.direction === "out" && e.kind === "vendor_mail" && e.reqId === r.id);
      if (prior) return { email_id: prior.id, recipients: prior.to.length, existing: true };
      const vendors = a.vendor_ids.includes("all")
        ? s().vendors
        : a.vendor_ids.map((id) => {
          const v = s().vendors.find((x) => x.id === id);
          if (!v) throw new DeskError(`Vendor ${id} not found. Use list_vendors, or pass ["all"].`);
          return v;
        });
      const e = send(a.actor, { kind: "vendor_mail", to: vendors.map((v) => v.email), subject: a.subject, body: a.body, reqId: r.id, attachments: [] });
      finish(a.actor, `Mailed ${vendors.length} C2C vendors about ${r.id}`,
        { name: "vendor_mail_sent", reqId: r.id, emailId: e.id, detail: { vendorIds: vendors.map((v) => v.id) } });
      return { email_id: e.id, recipients: vendors.length };
    },
    importVendorResumes(args: ToolArgs<"import_vendor_resumes">) {
      const a = parse("import_vendor_resumes", args);
      const r = req(a.req_id);
      const e = email(a.email_id);
      if (e.direction !== "in" || e.kind !== "vendor_reply" || e.reqId !== r.id) {
        throw new DeskError(`Email ${e.id} is not a vendor reply for ${r.id}. Use list_inbox with kind "vendor_reply".`);
      }
      const reply = s().script.vendorReplies.find((v) => v.vendorId === e.vendorId);
      const consultants = reply?.consultants ?? [];
      let added = 0;
      for (const c of consultants) {
        if (!s().candidates.some((x) => x.id === c.id)) s().candidates.push(structuredClone(c));
        if (!s().pipeline.some((p) => p.reqId === r.id && p.candidateId === c.id)) {
          s().pipeline.push({ reqId: r.id, candidateId: c.id, stage: "sourced", updatedAt: store.now() });
          added++;
        }
      }
      const vendor = s().vendors.find((v) => v.id === e.vendorId);
      finish(a.actor, `Imported ${added} consultant resume${added === 1 ? "" : "s"} from ${vendor?.name ?? "a vendor"} into ${r.id}`,
        { name: "vendor_resumes_imported", reqId: r.id, emailId: e.id, detail: { count: added } });
      return { candidate_ids: consultants.map((c) => c.id), added };
    },
    scoreCandidates(args: ToolArgs<"score_candidates">) {
      const a = parse("score_candidates", args);
      const entries = a.scores.map((sc) => entry(a.req_id, sc.candidate_id));
      let matched = 0;
      a.scores.forEach((sc, i) => {
        const e = entries[i]!;
        e.score = sc.score;
        e.scoreReasons = sc.reasons;
        e.updatedAt = store.now();
        if (sc.score >= 80 && e.stage === "sourced") {
          e.stage = "matched";
          matched++;
        }
      });
      finish(a.actor, `Scored ${a.scores.length} profiles on ${a.req_id}; ${matched} at 80+ moved to Matched`,
        { name: "candidates_scored", reqId: a.req_id, detail: { count: a.scores.length, matched } });
      return { scored: a.scores.length, matched };
    },
    moveCandidateStage(args: ToolArgs<"move_candidate_stage">) {
      const a = parse("move_candidate_stage", args);
      const e = entry(a.req_id, a.candidate_id);
      if (a.stage === "submitted") {
        throw new DeskError("Candidates reach Submitted only through send_submission, after the recruiter approves.");
      }
      e.stage = a.stage;
      e.updatedAt = store.now();
      finish(a.actor, `Moved ${candidate(a.candidate_id).name} to ${STAGE_LABELS[a.stage]}${a.note ? ` (${a.note})` : ""}`,
        { name: "stage_moved", reqId: a.req_id, candidateId: a.candidate_id, detail: { stage: a.stage } });
      return { candidate_id: a.candidate_id, stage: a.stage };
    },
    sendCandidateMessage(args: ToolArgs<"send_candidate_message">) {
      const a = parse("send_candidate_message", args);
      entry(a.req_id, a.candidate_id);
      const c = candidate(a.candidate_id);
      const e = send(a.actor, { kind: a.kind, to: [c.email], subject: a.subject, body: a.body, reqId: a.req_id, candidateId: c.id, attachments: [] });
      const what = { missed_call: "left a missed-call text for", text_screen: "sent a text screen to", rtr: "sent the RTR to", general: "messaged" }[a.kind];
      finish(a.actor, `${what[0]!.toUpperCase()}${what.slice(1)} ${c.name}`,
        { name: "candidate_message_sent", reqId: a.req_id, candidateId: c.id, emailId: e.id, detail: { kind: a.kind } });
      return { email_id: e.id };
    },
    logScreenResult(args: ToolArgs<"log_screen_result">) {
      const a = parse("log_screen_result", args);
      const e = entry(a.req_id, a.candidate_id);
      s().screens.push({
        reqId: a.req_id, candidateId: a.candidate_id, channel: a.channel, verdict: a.verdict, at: store.now(), actor: a.actor,
        answers: {
          interested: a.interested, availability: a.availability, noticePeriod: a.notice_period, payExpectation: a.pay_expectation,
          locationOk: a.location_ok, workAuthConfirmed: a.work_auth_confirmed, notes: a.notes,
        },
      });
      if (a.verdict === "pass") advance(e, "screened");
      finish(a.actor, `Screened ${candidate(a.candidate_id).name} by ${a.channel === "voice" ? "phone" : "text"}: ${a.verdict}`,
        { name: "screen_logged", reqId: a.req_id, candidateId: a.candidate_id, detail: { channel: a.channel, verdict: a.verdict } });
      return { candidate_id: a.candidate_id, verdict: a.verdict };
    },
    recordPaperwork(args: ToolArgs<"record_paperwork">) {
      const a = parse("record_paperwork", args);
      const e = entry(a.req_id, a.candidate_id);
      const c = candidate(a.candidate_id);
      const docs: Attachment[] = a.work_auth_doc_urls.map((ref) => {
        const doc = c.workAuthDocs.find((d) => d.url === ref || d.name === ref);
        if (!doc) {
          const valid = c.workAuthDocs.map((d) => d.url).join(", ") || "none (US citizen)";
          throw new DeskError(`Unknown document "${ref}" for ${c.id}. Use the attachment urls from their RTR reply: ${valid}.`);
        }
        return doc;
      });
      const complete = a.rtr_signed && a.rate_confirmed !== null && a.nda_signed && (docs.length > 0 || c.workAuth === "USC");
      const record = { reqId: a.req_id, candidateId: c.id, rtrSigned: a.rtr_signed, rateConfirmed: a.rate_confirmed, ndaSigned: a.nda_signed, workAuthDocs: docs, complete };
      const idx = s().paperwork.findIndex((p) => p.reqId === a.req_id && p.candidateId === c.id);
      if (idx >= 0) s().paperwork[idx] = record;
      else s().paperwork.push(record);
      if (complete) advance(e, "rtr");
      finish(a.actor, `${complete ? "Paperwork complete" : "Paperwork updated"} for ${c.name}: RTR ${a.rtr_signed ? "signed" : "pending"}, NDA ${a.nda_signed ? "signed" : "pending"}, ${docs.length} doc${docs.length === 1 ? "" : "s"}`,
        { name: "paperwork_recorded", reqId: a.req_id, candidateId: c.id, detail: { complete } });
      return { candidate_id: c.id, complete };
    },
    draftSubmission(args: ToolArgs<"draft_submission">) {
      const a = parse("draft_submission", args);
      entry(a.req_id, a.candidate_id);
      const r = req(a.req_id);
      const c = candidate(a.candidate_id);
      const paperwork = s().paperwork.find((p) => p.reqId === r.id && p.candidateId === c.id);
      const problems: string[] = [];
      if (!paperwork?.complete) problems.push("paperwork is not complete (record_paperwork first)");
      const missing = [
        !c.name && "name", !c.email && "email", !c.linkedin && "LinkedIn", c.noticeWeeks === undefined && "notice period",
        !c.availability && "availability", !c.education && "education",
        c.workAuth !== "USC" && !(paperwork?.workAuthDocs.length || c.workAuthDocs.length) && "work-auth document",
      ].filter(Boolean);
      if (missing.length) problems.push(`missing ${missing.join(", ")}`);
      if (problems.length) throw new DeskError(`Can't draft a submission for ${c.name} (${c.id}) on ${r.id}: ${problems.join("; ")}.`);
      const already = s().submissions.find((x) => x.reqId === r.id && x.candidateId === c.id);
      if (already?.status === "sent") throw new DeskError(`${c.name} was already submitted to ${r.client} for ${r.id} (${already.id}).`);
      const attachments: Attachment[] = [
        { name: `${c.name} resume.html`, url: `/docs/${c.id}/resume` },
        ...(paperwork!.workAuthDocs.length ? paperwork!.workAuthDocs : c.workAuthDocs),
      ];
      const fields = { subject: a.subject, body: a.body, billRate: a.bill_rate, attachments, to: r.clientContact };
      let id: string;
      if (already) {
        Object.assign(already, fields);
        id = already.id;
      } else {
        id = store.nextId("SUB");
        s().submissions.push({ id, reqId: r.id, candidateId: c.id, status: "draft", createdAt: store.now(), ...fields });
      }
      finish(a.actor, `Drafted the submission for ${c.name} to ${r.client} at $${a.bill_rate}/hr`,
        { name: "submission_drafted", reqId: r.id, candidateId: c.id, detail: { submissionId: id } });
      return { submission_id: id, to: r.clientContact, attachments: attachments.map((x) => x.name) };
    },
    sendSubmission(args: ToolArgs<"send_submission">) {
      const a = parse("send_submission", args);
      const sub = s().submissions.find((x) => x.id === a.submission_id);
      if (!sub) throw new DeskError(`Submission ${a.submission_id} not found. Use draft_submission first.`);
      if (sub.status === "sent") return { submission_id: sub.id, existing: true };
      const r = req(sub.reqId);
      const c = candidate(sub.candidateId);
      const e = send(a.actor, { kind: "submission", to: [sub.to], subject: sub.subject, body: sub.body, reqId: r.id, candidateId: c.id, attachments: sub.attachments });
      sub.status = "sent";
      sub.sentAt = store.now();
      sub.approvalQuote = a.approval_quote;
      advance(entry(r.id, c.id), "submitted");
      r.firstSubmittedAt ??= store.now();
      finish(a.actor, `Sent ${c.name} to ${r.client} (recruiter approved: "${a.approval_quote}")`,
        { name: "submission_sent", reqId: r.id, candidateId: c.id, emailId: e.id, detail: { submissionId: sub.id } });
      return { submission_id: sub.id, email_id: e.id };
    },
    scheduleInterview(args: ToolArgs<"schedule_interview">) {
      const a = parse("schedule_interview", args);
      const e = entry(a.req_id, a.candidate_id);
      const r = req(a.req_id);
      const c = candidate(a.candidate_id);
      const id = store.nextId("INT");
      s().interviews.push({ id, reqId: r.id, candidateId: c.id, round: a.round, when: a.when, interviewers: a.interviewers, status: "scheduled" });
      send(a.actor, {
        kind: "interview", to: [c.email, r.clientContact], subject: `Interview round ${a.round}: ${c.name} - ${r.title} (${a.when})`,
        body: `Hi ${firstName(c)} and team,\n\nRound ${a.round} for ${r.title} at ${r.client} is confirmed for ${a.when} with ${a.interviewers}. A reminder goes out the day before.\n\nRecruiting Desk`,
        reqId: r.id, candidateId: c.id, attachments: [],
      });
      advance(e, "interview");
      finish(a.actor, `Scheduled round ${a.round} for ${c.name} with ${r.client}: ${a.when}`,
        { name: "interview_scheduled", reqId: r.id, candidateId: c.id, detail: { interviewId: id } });
      return { interview_id: id };
    },
    logInterviewFeedback(args: ToolArgs<"log_interview_feedback">) {
      const a = parse("log_interview_feedback", args);
      const iv = s().interviews.find((x) => x.id === a.interview_id);
      if (!iv) throw new DeskError(`Interview ${a.interview_id} not found. Use get_candidate to see a candidate's interviews.`);
      iv.status = "done";
      iv.feedback = a.feedback;
      iv.outcome = a.outcome;
      if (a.outcome === "offer") advance(entry(iv.reqId, iv.candidateId), "offer");
      finish(a.actor, `Logged round ${iv.round} feedback for ${candidate(iv.candidateId).name}: ${a.outcome}`,
        { name: "interview_feedback_logged", reqId: iv.reqId, candidateId: iv.candidateId, detail: { interviewId: iv.id, outcome: a.outcome } });
      return { interview_id: iv.id, outcome: a.outcome };
    },
    updateOnboarding(args: ToolArgs<"update_onboarding">) {
      const a = parse("update_onboarding", args);
      const c = candidate(a.candidate_id);
      const e = s().pipeline.filter((p) => p.candidateId === c.id && (p.stage === "offer" || p.stage === "onboarding")).at(-1);
      if (!e) throw new DeskError(`${c.name} (${c.id}) has no accepted offer, so there is nothing to onboard.`);
      let record = s().onboarding.find((o) => o.candidateId === c.id && o.reqId === e.reqId);
      if (!record) {
        if (!a.path) throw new DeskError(`Pass path ("W2" or "C2C") to start onboarding ${c.name}.`);
        record = { reqId: e.reqId, candidateId: c.id, path: a.path, offerDocSent: false, bgv: "not_started", startConfirmed: false };
        s().onboarding.push(record);
      }
      if (a.path) record.path = a.path;
      if (a.offer_doc_sent !== undefined) record.offerDocSent = a.offer_doc_sent;
      if (a.bgv) record.bgv = a.bgv;
      if (a.laptop_tracking) record.laptopTracking = a.laptop_tracking;
      if (a.start_date) record.startDate = a.start_date;
      if (a.start_confirmed !== undefined) record.startConfirmed = a.start_confirmed;
      advance(e, "onboarding");
      const parts = [
        `${record.path === "W2" ? "W-2 offer letter" : "C2C MSA"} ${record.offerDocSent ? "sent" : "pending"}`, `BGV ${record.bgv.replace("_", " ")}`,
        record.laptopTracking ? `laptop ${record.laptopTracking}` : null, record.startDate ? `start ${record.startDate}${record.startConfirmed ? " (confirmed)" : ""}` : null,
      ].filter(Boolean);
      finish(a.actor, `Onboarding ${c.name}: ${parts.join(", ")}`, { name: "onboarding_updated", reqId: e.reqId, candidateId: c.id });
      return { candidate_id: c.id, onboarding: record };
    },
    requestTimesheet(args: ToolArgs<"request_timesheet">) {
      const a = parse("request_timesheet", args);
      const c = candidate(a.candidate_id);
      const ob = s().onboarding.find((o) => o.candidateId === c.id);
      if (!ob) throw new DeskError(`${c.name} (${c.id}) is not onboarded, so there is no timesheet to request.`);
      const existing = s().timesheets.find((t) => t.candidateId === c.id && t.month === a.month);
      if (!existing) s().timesheets.push({ candidateId: c.id, month: a.month, status: "requested" });
      const e = send(a.actor, {
        kind: "timesheet", to: [c.email], subject: `Timesheet for ${a.month}`,
        body: `Hi ${firstName(c)},\n\nPlease submit your ${a.month} hours so the client can approve them before billing.\n\nRecruiting Desk`,
        reqId: ob.reqId, candidateId: c.id, attachments: [],
      });
      finish(a.actor, `Requested the ${a.month} timesheet from ${c.name}`,
        { name: "timesheet_requested", reqId: ob.reqId, candidateId: c.id, emailId: e.id, detail: { month: a.month } });
      return { candidate_id: c.id, month: a.month, email_id: e.id };
    },
    recordTimesheet(args: ToolArgs<"record_timesheet">) {
      const a = parse("record_timesheet", args);
      const c = candidate(a.candidate_id);
      const existing = s().timesheets.find((t) => t.candidateId === c.id && t.month === a.month);
      if (existing) Object.assign(existing, { hours: a.hours, status: a.status });
      else s().timesheets.push({ candidateId: c.id, month: a.month, hours: a.hours, status: a.status });
      finish(a.actor, `Timesheet ${a.month} for ${c.name}: ${a.hours} h, ${a.status}`,
        { name: "timesheet_recorded", candidateId: c.id, detail: { month: a.month, status: a.status } });
      return { candidate_id: c.id, month: a.month, status: a.status };
    },
  };

  return {
    ...desk,
    /** Dispatch a tool by its snake_case name (used by the MCP server). */
    run(name: ToolName, args: unknown): unknown {
      const method = name.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase()) as keyof typeof desk;
      return (desk[method] as (x: unknown) => unknown)(args);
    },
  };
}

export type Desk = ReturnType<typeof createDesk>;
