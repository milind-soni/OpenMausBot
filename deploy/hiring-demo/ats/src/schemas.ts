// Input schemas for every desk tool. The MCP server validates with these; desk methods take their inferred types.
import { z } from "zod";

import { BOT_NAMES, STAGES } from "./types.ts";

const actor = z.enum(BOT_NAMES).describe("Your exact bot name");
const reqId = z.string().describe("Requirement id, e.g. REQ-1042");
const candidateIdField = z.string().describe("Candidate id, e.g. CAN-0123");
const board = z.enum(["dice", "monster", "linkedin"]);
const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt);

export const getDeskOverviewInput = z.object({});
export const getRequirementInput = z.object({ req_id: reqId });
export const listPipelineInput = z.object({
  req_id: reqId,
  stage: z.enum(STAGES).optional(),
  sort: z.enum(["keyword", "score"]).optional(),
  limit: limit(200, 50),
  include_resume: z.boolean().default(false),
});
export const searchCandidatesInput = z.object({
  query: z.string().describe('Boolean query: terms, "quoted phrases", AND, OR, NOT, parentheses'),
  req_id: reqId.optional().describe("Rank results by keyword fit for this requirement"),
  limit: limit(200, 50),
});
export const getCandidateInput = z.object({ candidate_id: candidateIdField });
export const listVendorsInput = z.object({});
export const listInboxInput = z.object({
  req_id: reqId.optional(),
  kind: z.string().optional(),
  since_id: z.string().optional().describe("Only emails newer than this email id"),
});
export const getEmailInput = z.object({ email_id: z.string() });
export const listOutboxInput = z.object({ req_id: reqId.optional() });
export const waitForRepliesInput = z.object({
  candidate_ids: z.array(candidateIdField).min(1).max(10),
  kind: z.enum(["text_screen_reply", "rtr_reply"]),
  timeout_seconds: z.number().int().min(1).max(90).default(60),
});

export const createRequirementInput = z.object({
  actor,
  source_email_id: z.string().describe("The client email this requirement came from"),
  title: z.string().min(2),
  client: z.string().min(2),
  client_contact: z.string().min(3).describe("Client contact email address"),
  location: z.string().min(2).describe('City, ST, e.g. "Dallas, TX"'),
  work_mode: z.enum(["onsite", "hybrid", "remote"]),
  rate: z.number().positive().describe("Max hourly bill rate in USD"),
  employment_type: z.enum(["C2C", "W2", "C2C or W2"]),
  skills: z.array(z.string()).min(1).describe("Must-have skills"),
  min_years: z.number().int().min(0),
  jd: z.string().min(10),
});
export const postJobInput = z.object({ actor, req_id: reqId, boards: z.array(board).min(1) });
export const addCandidatesToRequirementInput = z.object({
  actor,
  req_id: reqId,
  candidate_ids: z.array(candidateIdField).min(1).max(300),
  source: z.enum(["dice", "monster", "linkedin", "vendor", "database"]),
});
export const sendVendorMailInput = z.object({
  actor,
  req_id: reqId,
  vendor_ids: z.array(z.string()).min(1).describe('Vendor ids, or ["all"]'),
  subject: z.string().min(2),
  body: z.string().min(2),
});
export const importVendorResumesInput = z.object({ actor, req_id: reqId, email_id: z.string().describe("A vendor_reply email for this requirement") });
export const scoreCandidatesInput = z.object({
  actor,
  req_id: reqId,
  scores: z.array(z.object({ candidate_id: candidateIdField, score: z.number().int().min(0).max(100), reasons: z.string().min(2) })).min(1).max(50),
});
export const moveCandidateStageInput = z.object({ actor, req_id: reqId, candidate_id: candidateIdField, stage: z.enum(STAGES), note: z.string().optional() });
export const sendCandidateMessageInput = z.object({
  actor,
  req_id: reqId,
  candidate_id: candidateIdField,
  kind: z.enum(["missed_call", "text_screen", "rtr", "general"]),
  subject: z.string().min(2),
  body: z.string().min(2),
});
export const logScreenResultInput = z.object({
  actor,
  req_id: reqId,
  candidate_id: candidateIdField,
  channel: z.enum(["voice", "text"]),
  interested: z.boolean(),
  availability: z.string(),
  notice_period: z.string(),
  pay_expectation: z.string(),
  location_ok: z.boolean(),
  work_auth_confirmed: z.boolean(),
  notes: z.string(),
  verdict: z.enum(["pass", "hold", "fail"]),
});
export const recordPaperworkInput = z.object({
  actor,
  req_id: reqId,
  candidate_id: candidateIdField,
  rtr_signed: z.boolean(),
  rate_confirmed: z.number().positive().nullable(),
  nda_signed: z.boolean(),
  work_auth_doc_urls: z.array(z.string()).describe("Attachment urls from the candidate's RTR reply"),
});
export const draftSubmissionInput = z.object({
  actor,
  req_id: reqId,
  candidate_id: candidateIdField,
  subject: z.string().min(2),
  body: z.string().min(10),
  bill_rate: z.number().positive(),
});
export const sendSubmissionInput = z.object({
  actor,
  submission_id: z.string(),
  approval_quote: z.string().trim().min(2).describe("The recruiter's approval answer, word for word"),
});
export const scheduleInterviewInput = z.object({
  actor,
  req_id: reqId,
  candidate_id: candidateIdField,
  round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  when: z.string().min(3),
  interviewers: z.string().min(2),
});
export const logInterviewFeedbackInput = z.object({ actor, interview_id: z.string(), feedback: z.string().min(2), outcome: z.enum(["advance", "reject", "offer"]) });
export const updateOnboardingInput = z.object({
  actor,
  candidate_id: candidateIdField,
  path: z.enum(["W2", "C2C"]).optional(),
  offer_doc_sent: z.boolean().optional(),
  bgv: z.enum(["not_started", "in_progress", "clear"]).optional(),
  laptop_tracking: z.string().optional(),
  start_date: z.string().optional(),
  start_confirmed: z.boolean().optional(),
});
export const requestTimesheetInput = z.object({ actor, candidate_id: candidateIdField, month: z.string().regex(/^\d{4}-\d{2}$/) });
export const recordTimesheetInput = z.object({
  actor,
  candidate_id: candidateIdField,
  month: z.string().regex(/^\d{4}-\d{2}$/),
  hours: z.number().min(0).max(400),
  status: z.enum(["submitted", "approved", "billed"]),
});

/** Every tool the MCP server exposes, by its snake_case name. */
export const TOOL_SCHEMAS = {
  get_desk_overview: getDeskOverviewInput,
  get_requirement: getRequirementInput,
  list_pipeline: listPipelineInput,
  search_candidates: searchCandidatesInput,
  get_candidate: getCandidateInput,
  list_vendors: listVendorsInput,
  list_inbox: listInboxInput,
  get_email: getEmailInput,
  list_outbox: listOutboxInput,
  wait_for_replies: waitForRepliesInput,
  create_requirement: createRequirementInput,
  post_job: postJobInput,
  add_candidates_to_requirement: addCandidatesToRequirementInput,
  send_vendor_mail: sendVendorMailInput,
  import_vendor_resumes: importVendorResumesInput,
  score_candidates: scoreCandidatesInput,
  move_candidate_stage: moveCandidateStageInput,
  send_candidate_message: sendCandidateMessageInput,
  log_screen_result: logScreenResultInput,
  record_paperwork: recordPaperworkInput,
  draft_submission: draftSubmissionInput,
  send_submission: sendSubmissionInput,
  schedule_interview: scheduleInterviewInput,
  log_interview_feedback: logInterviewFeedbackInput,
  update_onboarding: updateOnboardingInput,
  request_timesheet: requestTimesheetInput,
  record_timesheet: recordTimesheetInput,
} as const;

/** Demo controls the hosted demo gives the Desk Manager, so a person can start a run by asking in Desk HQ. */
export const DEMO_TOOL_SCHEMAS = {
  demo_new_requirement: z.object({ actor }),
  demo_next_morning: z.object({ actor }),
  demo_reset: z.object({ actor }),
} as const;
export type DemoToolName = keyof typeof DEMO_TOOL_SCHEMAS;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export type ToolArgs<N extends ToolName> = z.input<(typeof TOOL_SCHEMAS)[N]>;
export type ToolParsed<N extends ToolName> = z.output<(typeof TOOL_SCHEMAS)[N]>;
