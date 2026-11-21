import { t } from "@/lib/i18n";
import { type Bot } from "@/state/store";
import { useBotEditor } from "./BotEditorContext";
import { useStoreSelector } from "@/state/store-select";

const sectionKey = (section?: string | null) => (section ?? "").trim();

/** The same reach server/peer-roster.ts grants a Chief for proposals. */
function chiefCovers(bot: Bot, bots: ReadonlyArray<Bot>): boolean {
  const target = sectionKey(bot.section);
  return bots.some((candidate) =>
    candidate.id !== bot.id &&
    Boolean(candidate.chiefOfStaff) &&
    (sectionKey(candidate.section) === target ||
      (Array.isArray(candidate.managedSections) &&
        candidate.managedSections.some((team) => typeof team === "string" && sectionKey(team) === target))));
}

export function ProposalStatus({ bot, kind }: { bot: Bot; kind: "chief" | "owner" }) {
  const { draft } = useBotEditor();
  const covered = useStoreSelector((s) => chiefCovers(bot, s.bots));
  if (draft || !covered) return null;
  return (
    <div className="mt-1 text-[12px] leading-snug text-ink-secondary">
      {t(kind === "chief" ? "botSettings.proposal.chief" : "botSettings.proposal.owner")}
    </div>
  );
}
