import { z } from "zod";

/** Where a bot's Edu brain lives. `own` (the default when absent): a brain of its own in the app's data folder, created on
 * first use. `folder`: the `.edu` brain already in `path`, which several bots may share. `off`: no Edu brain. */
export type EduBrainSetting = { mode: "off" } | { mode: "own" } | { mode: "folder"; path: string };

export interface EduBrainField {
  /** This bot's Edu brain. Absent: its own. */
  eduBrain?: EduBrainSetting;
  /** Edu crew: the bot may ask Edu to plan and build (each gate approved by a person) or to review. Absent: off. */
  eduCrew?: boolean;
}

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** An `EduBrainSetting` as a file carries it; `folder` needs an absolute path. */
export const eduBrainSettingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("own") }),
  z.object({ mode: z.literal("folder"), path: z.string().trim().max(4096).refine((path) => ABSOLUTE_PATH.test(path) && !path.includes("\0"), "must be an absolute folder path") }),
]);

export type EduState = "off" | "missing" | "old" | "broken" | "ready";

/** A canonical note Edu keeps as `proposed` until a person approves or rejects it (`edu brain proposals --json`). */
export interface EduProposal {
  id: string;
  title: string;
  /** Edu's canonical kind: identity, standard, lexicon, domain, person or preference. */
  kind: string;
  /** Edu's claim band: verified, inferred, hypothesis or unbanded. */
  band: string;
  /** Edu's own words on why it waits for a person. */
  why: string;
  /** The folder holding the bot's `.edu` brain; approving runs there. */
  brain: string;
  /** The note is in the global brain every coding CLI with Edu reads, not in the bot's own brain. */
  global: boolean;
  /** The brain folder the note joins: `brain` for the bot's own, Edu's global home for a global one. */
  location: string;
  /** The bot's brain is a folder it names (`mode: folder`), which other bots may share. */
  shared?: boolean;
  /** The proposed note's text, shortened. */
  body?: string;
}

export interface EduProposalCardField {
  /** A card asking the person to approve or reject an Edu canonical proposal. */
  eduProposal?: EduProposal;
}

/** `GET /api/bots/:id/edu`. */
export interface EduBrainView {
  state: EduState;
  mode: EduBrainSetting["mode"];
  /** The folder whose `.edu` is this bot's brain. */
  brain?: string;
  /** The global brain the bot reads as well. */
  home: string;
  version?: string;
  reason?: string;
  /** With `broken`: Edu works, and the bot's brain folder is what it can't use. */
  brokenFolder?: boolean;
  /** Pending proposals in the bot's brain and the global one, including those made outside Edu Bot. */
  proposals: EduProposal[];
  /** Why the proposals could not be listed this time. */
  listError?: string;
  /** Whether this caller may approve; anyone who may see the list may reject. */
  mayApprove: boolean;
  /** Edu Bot itself runs inside an Edu crew job, so Edu refuses every decision. */
  crewWorker?: boolean;
  crew?: EduCrewView;
}

/** `GET /api/edu/rights`: what this caller may do with an Edu proposal, by the same rule as `EduBrainView`. */
export interface EduDecideRights {
  mayApprove: boolean;
  mayReject: boolean;
  crewWorker?: boolean;
}

/** Edu's read-only reviewers: the CLIs Edu 6.0.0 can hold to read-only work. */
export const EDU_CREW_REVIEWERS = ["codex", "claude", "pi"] as const;
export type EduCrewReviewer = (typeof EDU_CREW_REVIEWERS)[number];

/** Where an Edu crew job stands, in Edu Bot's words. */
export type EduCrewStatus = "running" | "waiting" | "done" | "failed" | "cancelled";

/** The quiet line an Edu crew job keeps in its conversation (`WireMessage.eduCrew`), rewritten in place as it moves on. */
export interface EduCrewLine {
  /** Edu's job id. */
  jobId: string;
  /** `plan`: Edu's plan, build, checks and review loop. `review`: one read-only review by another vendor's CLI. */
  kind: "plan" | "review";
  status: EduCrewStatus;
  /** The goal or the review question, shortened. */
  title: string;
  /** The reviewer CLI, for a review. */
  cli?: string;
  /** Failed: one line saying why. Done: Edu's summary, shortened. */
  why?: string;
  /** When the status last changed, epoch ms. */
  at: number;
}

/** `WireMessage.eduCrew`. */
export interface EduCrewLineField {
  eduCrew?: EduCrewLine;
}

/** A card asking the person to pass one of Edu's approval gates (the spec, then each step) for a crew job. */
export interface EduCrewGate {
  jobId: string;
  /** Edu's id for the open gate; deciding names it, so a decision never lands on a later gate. */
  gateId: string;
  /** Edu's name for the gate, e.g. "Approve spec". */
  gate: string;
  goal: string;
  /** The spec Edu wrote, shortened. */
  spec?: string;
  /** Shell commands the planner proposed that approving this gate runs. */
  commands?: string[];
  /** The folder the crew works in. */
  folder: string;
}

export interface EduCrewGateCardField {
  eduCrewGate?: EduCrewGate;
}

/** A card only a person decides, outside any turn: no turn, call or composer waits on it. */
export function isEduDecisionCard(card: (EduProposalCardField & EduCrewGateCardField) | undefined | null): boolean {
  return Boolean(card?.eduProposal || card?.eduCrewGate);
}

/** `EduBrainView.crew`: this bot's Edu crew switch and whether it can work now. */
export interface EduCrewView {
  enabled: boolean;
  /** Why the crew cannot work for this bot now, when it cannot. */
  blocked?: string;
  /** The folder crew jobs would work in. */
  folder?: string;
}

/** `GET /api/edu/crew/:jobId`: what the status line's Details shows. */
export interface EduCrewDetails {
  line: EduCrewLine;
  folder: string;
  spec?: string;
  summary?: string;
}
