import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { eduProposalFacts } from "@/lib/edu-proposal-words";
import type { EduProposal } from "../../shared/edu-brain";
import { AskDetail } from "./AskCard";

/** An Edu proposal in plain words: its title, what kind of note it is and where it goes, its text, and for the global
 * brain what approving changes. Edu's own fields stay behind the card's details. */
export function EduProposalLines({ proposal, place, titleClassName }: { proposal: EduProposal; place?: string; titleClassName?: string }) {
  const facts = [eduProposalFacts(proposal), place].filter(Boolean).join(" · ");
  return (
    <>
      <p dir="auto" data-edu-title className={cn("mt-1.5 break-words text-[15px] font-medium leading-[22px] text-ink", titleClassName)}>{proposal.title}</p>
      {facts && <p data-edu-facts className="mt-0.5 text-[13px] leading-[18px] text-ink-secondary">{facts}</p>}
      {proposal.body && <AskDetail text={proposal.body} label={t("approval.aria.reviewDetails")} />}
      {proposal.global && <p data-edu-global className="mt-2 text-[13px] leading-[18px] text-warning">{t("server.edu.globalWarning")}</p>}
    </>
  );
}
