import { z } from "zod";

/** Where a bot's Edu brain lives. `own` (the default when absent): a brain of its own in the app's data folder, created on
 * first use. `folder`: the `.edu` brain already in `path`, which several bots may share. `area`: one brain in the app's
 * data folder shared by every bot of the area `area` on this computer, created on first use. `cloud`: an edu-cloud brain
 * at `url`, reached with this person's token. `off`: no Edu brain. */
export type EduBrainSetting =
  | { mode: "off" }
  | { mode: "own" }
  | { mode: "folder"; path: string }
  | { mode: "area"; area: string; personalBrain?: false }
  | { mode: "cloud"; url: string; token: EduCloudToken };

/** Where this person's edu-cloud token comes from: a secret of that name in their Vault, or an environment variable of
 * the app. Never the token itself. */
export type EduCloudToken = { secret: string } | { env: string };

export interface EduBrainField {
  /** This bot's Edu brain. Absent: its own. */
  eduBrain?: EduBrainSetting;
  /** Edu crew: the bot may ask Edu to plan and build (each gate approved by a person) or to review. Absent: off. */
  eduCrew?: boolean;
}

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
export const EDU_AREA_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Why `value` cannot be an edu-cloud address, or null: https, or http on this computer only, with no user, query or
 * fragment, ending in /mcp. */
export function eduCloudUrlProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return "must be a full https:// address"; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return "must be an https:// address (http:// only for this computer)";
  if (url.username || url.password) return "must not hold a user name or password";
  if (url.search || url.hash || value.includes("?") || value.includes("#")) return "must be a plain address, without ? or #";
  if (!url.pathname.replace(/\/+$/, "").endsWith("/mcp")) return "must be the brain's /mcp address";
  return null;
}

const cloudTokenSchema = z.union([
  z.object({ secret: z.string().regex(SECRET_NAME) }).strict(),
  z.object({ env: z.string().regex(ENV_NAME) }).strict(),
]);

/** An `EduBrainSetting` as a file carries it; `folder` needs an absolute path. */
export const eduBrainSettingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("own") }),
  z.object({ mode: z.literal("folder"), path: z.string().trim().max(4096).refine((path) => ABSOLUTE_PATH.test(path) && !path.includes("\0"), "must be an absolute folder path") }),
  z.object({ mode: z.literal("area"), area: z.string().regex(EDU_AREA_KEY), personalBrain: z.literal(false).optional() }),
  z.object({ mode: z.literal("cloud"), url: z.string().max(2000).refine((url) => eduCloudUrlProblem(url) === null, "must be an https:// address"), token: cloudTokenSchema }),
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
  /** The note waits in an edu-cloud brain: `brain` is its address, and a steward decides it there. */
  cloud?: true;
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
  /** With `area`: the bot does not read the person's own global brain. */
  personalBrain?: false;
  /** With `cloud`: what this person's token may do there. */
  cloud?: EduCloudView;
}

/** `EduBrainView.cloud`. */
export interface EduCloudView {
  url: string;
  /** The name of the Vault secret or environment variable that holds this person's token. */
  token: string;
  /** No value is saved under `token` yet. */
  tokenMissing?: true;
  /** The token's label and scope there, when the server says. */
  label?: string;
  scope?: "member" | "steward";
  /** The server has the review routes. Without them (an older edu-cloud) proposals are decided on the server itself. */
  review: boolean;
  /** Why the server could not be asked this time. */
  error?: string;
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
