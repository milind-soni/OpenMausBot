import { UserPlus, Users } from "lucide-react";

import { t } from "@/lib/i18n";
import type { Task } from "@/state/store";
import { useOptionalStoreRef } from "@/state/store-ref";
import { openConversationDialog, shareChoices } from "./conversation-share";

const ROW = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover";

/** "Share with the team" and "Share with…" in a conversation's row menu, for the person it is private to. */
export function ShareRowItems({ botId, task, onPicked }: { botId: string; task: Pick<Task, "threadId" | "private" | "shared" | "sharedWith" | "sharedChat">; onPicked: () => void }) {
  const state = useOptionalStoreRef()?.state();
  const bot = state?.bots.find((candidate) => candidate.id === botId);
  const choices = bot ? shareChoices(bot, task, Boolean(state?.config?.team)) : { team: false, person: false };
  const open = (kind: "team" | "person") => { onPicked(); openConversationDialog({ kind, botId, threadId: task.threadId }); };
  return <>
    {choices.team && <button type="button" data-share-conversation="team" onClick={() => open("team")} className={ROW}><Users size={16} />{t("conversationShare.withTeam")}</button>}
    {choices.person && <button type="button" data-share-conversation="person" onClick={() => open("person")} className={ROW}><UserPlus size={16} />{t("conversationShare.withPerson")}</button>}
  </>;
}
