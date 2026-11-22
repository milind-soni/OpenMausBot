import { z } from "zod";

/** Where a bot's Edu brain lives. `own` (the default when absent): a brain of its own in the app's data folder, created on
 * first use. `folder`: the `.edu` brain already in `path`, which several bots may share. `off`: no Edu brain. */
export type EduBrainSetting = { mode: "off" } | { mode: "own" } | { mode: "folder"; path: string };

export interface EduBrainField {
  /** This bot's Edu brain. Absent: its own. */
  eduBrain?: EduBrainSetting;
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
  /** Pending proposals in the bot's brain and the global one, including those made outside Edu Bot. */
  proposals: EduProposal[];
  /** Why the proposals could not be listed this time. */
  listError?: string;
  /** Whether this caller may approve; anyone who may see the list may reject. */
  mayApprove: boolean;
  /** Edu Bot itself runs inside an Edu crew job, so Edu refuses every decision. */
  crewWorker?: boolean;
}

/** `GET /api/edu/rights`: what this caller may do with an Edu proposal, by the same rule as `EduBrainView`. */
export interface EduDecideRights {
  mayApprove: boolean;
  mayReject: boolean;
  crewWorker?: boolean;
}
