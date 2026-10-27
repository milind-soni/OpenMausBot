import { Check, Crown, MessageSquare } from "lucide-react";

import { prependComposerDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import type { GrokSetupNotes } from "@/lib/team-import";
import { useStore, type Action, type Bot } from "@/state/store";

/** Something is left to do: apps to connect, Grok-only tools, or what the export could not carry. */
export const grokSetupLeft = (notes: GrokSetupNotes | undefined): notes is GrokSetupNotes =>
  Boolean(notes && (notes.apps.length || notes.unmatched.length || notes.leftOut.length));

/** Who finishes the setup: the Chief of Staff, or the imported bot itself when there is none. */
export function setupHelper(bots: readonly Bot[], imported: Bot): { bot: Bot; chief: boolean } {
  const chief = bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
  return chief ? { bot: chief, chief: true } : { bot: imported, chief: false };
}

/** The first message for the helper, prepared in its composer and never sent for the person. */
export function grokSetupMessage(botName: string, notes: GrokSetupNotes): string {
  const routines = notes.leftOut.filter((item) => item.kind === "routine");
  const other = notes.leftOut.filter((item) => item.kind !== "routine");
  const line = (item: GrokSetupNotes["leftOut"][number]) =>
    `- ${item.name}: ${item.reason}.${item.original ? `\n  ${item.original.replace(/\n/g, "\n  ")}` : ""}`;
  return [
    notes.sourceUrl
      ? t("grokFinish.messageFromLink", { name: botName, url: notes.sourceUrl })
      : t("grokFinish.messageFromGrok", { name: botName }),
    notes.apps.length ? t("grokFinish.messageApps", { apps: notes.apps.map((app) => `${app.label} (${app.slug})`).join(", ") }) : "",
    notes.unmatched.length ? t("grokFinish.messageUnmatched", { tools: notes.unmatched.join(", ") }) : "",
    routines.length ? `${t("grokFinish.messageRoutines")}\n${routines.map(line).join("\n")}` : "",
    other.length ? `${t("grokFinish.messageOther")}\n${other.map(line).join("\n")}` : "",
    t("grokFinish.messageAsk"),
  ].filter(Boolean).join("\n\n");
}

/** Opens the helper's chat with the message in its composer, ahead of anything already typed there. Never sends it. */
export function openSetupChat(helper: Bot, imported: Bot, notes: GrokSetupNotes, dispatch: (action: Action) => void): void {
  prependComposerDraft(`bot:${helper.id}:${helper.threadId}`, grokSetupMessage(imported.name, notes));
  dispatch({ type: "showChat" });
  dispatch({ type: "select", id: helper.id });
}

/** After Add: what is left, and one button that opens the helper's chat with the message ready to send. */
export function GrokFinishSetup({ notes, imported, onDone, className = "min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-6 sm:px-8" }: {
  notes: GrokSetupNotes; imported: Bot; onDone: () => void; className?: string;
}) {
  const { state, dispatch } = useStore();
  const helper = setupHelper(state.bots, imported);
  const routines = notes.leftOut.filter((item) => item.kind === "routine").length;
  const open = () => {
    openSetupChat(helper.bot, imported, notes, dispatch);
    onDone();
  };
  return (
    <div className={className}>
      <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
        <Check size={17} className="text-success" />
        {t("grokFinish.added", { name: imported.name })}
      </div>
      <ul className="mt-3 list-disc pl-5 text-[13px] leading-relaxed text-ink-secondary">
        {notes.apps.length > 0 && <li>{t("grokFinish.apps", { apps: notes.apps.map((app) => app.label).join(", ") })}</li>}
        {notes.unmatched.length > 0 && <li>{t("grokFinish.unmatched", { tools: notes.unmatched.join(", ") })}</li>}
        {routines > 0 && <li>{t("grokFinish.routines", { count: routines })}</li>}
        {notes.leftOut.length > routines && <li>{t("grokFinish.other", { count: notes.leftOut.length - routines })}</li>}
      </ul>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          onClick={open}
          className="flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-medium text-white hover:bg-accent/90"
        >
          {helper.chief ? <Crown size={15} /> : <MessageSquare size={15} />}
          {helper.chief ? t("grokFinish.askChief") : t("grokFinish.askBot", { name: imported.name })}
        </button>
        <button onClick={onDone} className="rounded-full bg-raised px-4 py-2.5 text-[13px] text-ink hover:bg-raised-hover">
          {t("grokFinish.later")}
        </button>
      </div>
      <p className="mt-2 text-[12px] text-ink-tertiary">{t("grokFinish.hint")}</p>
    </div>
  );
}
