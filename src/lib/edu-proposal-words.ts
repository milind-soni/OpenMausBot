import { t } from "@/lib/i18n";
import type { EduDecideRights, EduProposal } from "../../shared/edu-brain";
import * as words from "../../shared/edu-proposal-words";

const say: words.EduSay = (key, params) => t(key, params);

export const eduProposalTitle = (proposal: EduProposal, botName: string): string => words.eduProposalTitle(proposal, botName, say);
export const eduProposalFacts = (proposal: EduProposal): string => words.eduProposalFacts(proposal, say);
export const eduProposalPlace = (proposal: EduProposal, botName: string): string => words.eduProposalPlace(proposal, botName, say);
export const eduProposalSummary = (proposal: EduProposal, botName?: string): string => words.eduProposalSummary(proposal, botName, say);
export const eduProposalFields = words.eduProposalFields;

/** What a settled Edu proposal card says. */
export function eduProposalOutcome(answered: string | undefined): string | undefined {
  if (!answered) return undefined;
  return t(answered === "allow" ? "eduBrain.status.approved" : answered === "deny" ? "eduBrain.status.rejected" : "eduBrain.status.gone");
}

/** Why this person can't press Approve or Reject here, in Memory settings' words; undefined when they can. */
export function eduRightsNote(rights: EduDecideRights): string | undefined {
  if (rights.crewWorker) return t("eduBrain.crewWorker");
  if (!rights.mayApprove && rights.mayReject) return t("eduBrain.approveElsewhere");
  if (!rights.mayApprove) return t("eduBrain.adminOnly");
  return undefined;
}
