// Domain model for Desk ATS. Every module and the seed share these shapes.

export const STAGES = ["sourced", "matched", "screened", "rtr", "submitted", "interview", "offer", "onboarding"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  sourced: "Sourced",
  matched: "Matched",
  screened: "Screened",
  rtr: "RTR",
  submitted: "Submitted",
  interview: "Interview",
  offer: "Offer",
  onboarding: "Onboarding",
};

export const BOT_NAMES = [
  "Desk Manager",
  "Job Board Sourcer",
  "Vendor Bench",
  "Matcher",
  "Phone Screener",
  "Paperwork",
  "Submission Writer",
  "Interview Coordinator",
  "Onboarding",
  "Timesheets",
] as const;
export type BotName = (typeof BOT_NAMES)[number];

export type WorkAuth = "USC" | "GC" | "H-1B" | "H-4 EAD" | "OPT";
export type Board = "dice" | "monster" | "linkedin";
export type Source = Board | "vendor" | "database";

export interface ScreenAnswers {
  interested: boolean;
  availability: string;
  noticePeriod: string;
  payExpectation: string;
  locationOk: boolean;
  workAuthConfirmed: boolean;
  notes: string;
}

export interface Attachment {
  name: string;
  url: string;
}

export interface Candidate {
  id: string;
  name: string;
  email: string;
  phone: string;
  linkedin: string;
  title: string;
  location: string;
  relocate: boolean;
  workAuth: WorkAuth;
  years: number;
  skills: string[];
  rateExpectation: number;
  noticeWeeks: number;
  availability: string;
  education: string;
  resume: string;
  source: Source;
  vendorId?: string;
  contactPreference: "phone" | "text";
  screenAnswers?: ScreenAnswers;
  workAuthDocs: Attachment[];
}

export interface Requirement {
  id: string;
  title: string;
  client: string;
  clientContact: string;
  location: string;
  workMode: "onsite" | "hybrid" | "remote";
  rate: number;
  employmentType: "C2C" | "W2" | "C2C or W2";
  skills: string[];
  minYears: number;
  jd: string;
  status: "open" | "on_hold" | "filled";
  receivedAt: number;
  firstSubmittedAt?: number;
  postedOn: Board[];
  sourceEmailId?: string;
}

export interface PipelineEntry {
  reqId: string;
  candidateId: string;
  stage: Stage;
  score?: number;
  scoreReasons?: string;
  updatedAt: number;
}

export type EmailKind =
  | "client_requirement"
  | "vendor_mail"
  | "vendor_reply"
  | "missed_call"
  | "text_screen"
  | "text_screen_reply"
  | "rtr"
  | "rtr_reply"
  | "submission"
  | "interview"
  | "client_feedback"
  | "offer_accepted"
  | "onboarding"
  | "timesheet"
  | "timesheet_reply"
  | "general";

export interface Email {
  id: string;
  direction: "in" | "out";
  kind: EmailKind;
  from: string;
  to: string[];
  subject: string;
  body: string;
  at: number;
  reqId?: string;
  candidateId?: string;
  vendorId?: string;
  attachments: Attachment[];
  actor?: BotName;
}

export type EmailDraft = Omit<Email, "id" | "at" | "direction">;

export interface Screen {
  reqId: string;
  candidateId: string;
  channel: "voice" | "text";
  answers: ScreenAnswers;
  verdict: "pass" | "hold" | "fail";
  at: number;
  actor: BotName;
}

export interface Paperwork {
  reqId: string;
  candidateId: string;
  rtrSigned: boolean;
  rateConfirmed: number | null;
  ndaSigned: boolean;
  workAuthDocs: Attachment[];
  complete: boolean;
}

export interface Submission {
  id: string;
  reqId: string;
  candidateId: string;
  to: string;
  subject: string;
  body: string;
  billRate: number;
  attachments: Attachment[];
  status: "draft" | "sent";
  approvalQuote?: string;
  createdAt: number;
  sentAt?: number;
}

export interface Interview {
  id: string;
  reqId: string;
  candidateId: string;
  round: 1 | 2 | 3;
  when: string;
  interviewers: string;
  status: "scheduled" | "done";
  feedback?: string;
  outcome?: "advance" | "reject" | "offer";
}

export interface Onboarding {
  reqId: string;
  candidateId: string;
  path: "W2" | "C2C";
  offerDocSent: boolean;
  bgv: "not_started" | "in_progress" | "clear";
  laptopTracking?: string;
  startDate?: string;
  startConfirmed: boolean;
}

export interface Timesheet {
  candidateId: string;
  month: string;
  hours?: number;
  status: "requested" | "submitted" | "approved" | "billed";
}

export interface Vendor {
  id: string;
  name: string;
  contact: string;
  email: string;
  benchSize: number;
}

export interface Activity {
  at: number;
  actor: string;
  text: string;
  reqId?: string;
  candidateId?: string;
}

export interface PendingReply {
  id: string;
  dueAt: number;
  email: EmailDraft;
  /** The event emitted when the reply arrives. (Not `then`: an object with a `then` key looks like a promise.) */
  fires: "vendor_reply_received" | "candidate_reply_received";
}

export interface SeedScript {
  heroClientEmail: EmailDraft;
  vendorReplies: { vendorId: string; body: string; consultants: Candidate[] }[];
  morning: { feedbackEmail: EmailDraft; offerAcceptedEmail: EmailDraft; timesheetMonth: string };
}

export interface DeskState {
  requirements: Requirement[];
  candidates: Candidate[];
  pipeline: PipelineEntry[];
  emails: Email[];
  screens: Screen[];
  paperwork: Paperwork[];
  submissions: Submission[];
  interviews: Interview[];
  onboarding: Onboarding[];
  timesheets: Timesheet[];
  vendors: Vendor[];
  activity: Activity[];
  pending: PendingReply[];
  script: SeedScript;
  counters: Record<string, number>;
  flags: { clientEmailDelivered: boolean; morningDelivered: boolean };
}

export type DeskEventName =
  | "reset"
  | "client_email_received"
  | "requirement_created"
  | "job_posted"
  | "candidates_added"
  | "vendor_mail_sent"
  | "vendor_reply_received"
  | "vendor_resumes_imported"
  | "candidates_scored"
  | "stage_moved"
  | "candidate_message_sent"
  | "candidate_reply_received"
  | "screen_logged"
  | "paperwork_recorded"
  | "submission_drafted"
  | "submission_sent"
  | "interview_scheduled"
  | "interview_feedback_logged"
  | "onboarding_updated"
  | "timesheet_requested"
  | "timesheet_recorded"
  | "morning_events"
  | "webhook_failed";

export interface DeskEvent {
  name: DeskEventName;
  at: number;
  reqId?: string;
  candidateId?: string;
  emailId?: string;
  detail?: Record<string, unknown>;
}
