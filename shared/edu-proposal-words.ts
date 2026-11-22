import type { EduProposal } from "./edu-brain.ts";

const KIND_WORDS = {
  standard: "server.edu.kind.standard",
  preference: "server.edu.kind.preference",
  identity: "server.edu.kind.identity",
  person: "server.edu.kind.person",
  domain: "server.edu.kind.domain",
  lexicon: "server.edu.kind.lexicon",
} as const;

const BAND_WORDS = {
  verified: "server.edu.band.verified",
  inferred: "server.edu.band.inferred",
  hypothesis: "server.edu.band.hypothesis",
} as const;

export type EduWordKey =
  | (typeof KIND_WORDS)[keyof typeof KIND_WORDS]
  | (typeof BAND_WORDS)[keyof typeof BAND_WORDS]
  | "server.edu.titleOwn" | "server.edu.titleShared" | "server.edu.titleGlobal"
  | "server.edu.placeOwn" | "server.edu.placeShared" | "server.edu.placeGlobal"
  | "server.edu.globalWarning";

/** The server's or the client's translation of an Edu word. */
export type EduSay = (key: EduWordKey, params?: Readonly<Record<string, string>>) => string;

type Proposal = Pick<EduProposal, "kind" | "band" | "global" | "brain"> & { shared?: boolean; cloud?: boolean };

const wordOf = <T extends Record<string, EduWordKey>>(words: T, value: string): EduWordKey | undefined =>
  Object.hasOwn(words, value) ? words[value as keyof T] : undefined;

const folderName = (path: string) => path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path;

/** A shared brain by name: an edu-cloud brain by its host, a folder (an area's is named by its key) by its last part. */
function sharedName(proposal: Proposal): string {
  if (!proposal.cloud) return folderName(proposal.brain);
  try { return new URL(proposal.brain).host; } catch { return proposal.brain; }
}

/** Edu's kind and claim band as plain words; an unknown kind and an unbanded note say nothing. */
export function eduProposalFacts(proposal: Proposal, say: EduSay): string {
  return [wordOf(KIND_WORDS, proposal.kind), wordOf(BAND_WORDS, proposal.band)].flatMap((key) => (key ? [say(key)] : [])).join(" · ");
}

/** The brain the note joins, by name. */
export function eduProposalPlace(proposal: Proposal, botName: string, say: EduSay): string {
  if (proposal.global) return say("server.edu.placeGlobal");
  return proposal.shared ? say("server.edu.placeShared", { folder: sharedName(proposal) }) : say("server.edu.placeOwn", { name: botName });
}

export function eduProposalTitle(proposal: Proposal, botName: string, say: EduSay): string {
  if (proposal.global) return say("server.edu.titleGlobal");
  return proposal.shared ? say("server.edu.titleShared", { folder: sharedName(proposal) }) : say("server.edu.titleOwn", { name: botName });
}

/** The proposal in plain words: its title, what kind of note it is, its text, where it goes (a bot's own brain only
 * when the bot is named) and, for the global brain, what approving changes. */
export function eduProposalSummary(proposal: EduProposal, botName: string | undefined, say: EduSay): string {
  const facts = eduProposalFacts(proposal, say);
  const lines = [proposal.title, ...(facts ? [facts] : [])];
  if (proposal.body) lines.push("", proposal.body);
  if (botName !== undefined || proposal.global || proposal.shared) lines.push("", eduProposalPlace(proposal, botName ?? "", say));
  if (proposal.global) lines.push(say("server.edu.globalWarning"));
  return lines.join("\n");
}

/** Edu's own fields, as Edu wrote them, for whoever opens the details. */
export function eduProposalFields(proposal: EduProposal): string {
  return [["id", proposal.id], ["kind", proposal.kind], ["band", proposal.band], ["why", proposal.why], ["path", proposal.location]]
    .filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`).join("\n");
}
