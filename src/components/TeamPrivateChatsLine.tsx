import { useState, type ReactNode } from "react";
import { Lock, UserRound, Users } from "lucide-react";
import { t } from "@/lib/i18n";

const SEEN_KEY = (teamId: string) => `omb.team-private-chats.${teamId}`;

/** Whether this team's sentence is still to be said here; saying it marks it said, so it shows in one private chat only. */
export function teamPrivateChatsLineDue(teamId: string, storage: Pick<Storage, "getItem" | "setItem"> | null): boolean {
  if (!storage) return true;
  try {
    if (storage.getItem(SEEN_KEY(teamId))) return false;
    storage.setItem(SEEN_KEY(teamId), String(Date.now()));
    return true;
  } catch {
    return true;
  }
}

/** In every private chat with a team's bot, beside its name: who can see it. */
export function TeamPrivateHeader() {
  return <ChatHeadAudience icon={<Lock size={12} aria-hidden="true" className="shrink-0" />} label={t("team.privateHeader")} data-chathead-private="" />;
}

/** In a team bot's shared chats (its main chat, a routine's report): everyone in the team can read them. */
export function TeamSharedHeader({ team }: { team: { name: string } }) {
  return <ChatHeadAudience icon={<Users size={12} aria-hidden="true" className="shrink-0" />} label={t("team.sharedHeader", { team: team.name })} data-chathead-shared="" />;
}

/** On a narrow header only the icon shows, so the bot's name keeps its room. */
function ChatHeadAudience({ icon, label, ...data }: { icon: ReactNode; label: string } & Record<`data-${string}`, string>) {
  return <span {...data} title={label} className="flex min-w-0 items-center gap-1 text-[12px] text-ink-secondary">
    {icon}<span className="truncate @max-[30rem]/chathead:sr-only">{label}</span>
  </span>;
}

/** In a member's own MausBot's chats: that member's helper, which other members never see. */
export function TeamOwnHelperHeader() {
  return <ChatHeadAudience icon={<UserRound size={12} aria-hidden="true" className="shrink-0" />} label={t("team.ownHelperHeader")} data-chathead-own-helper="" />;
}

/** Above the first private chat with any of the team's bots on this device, once: the same thing as a sentence. */
export function TeamPrivateFirstLine({ team }: { team: { id: string; name: string } }) {
  const [due] = useState(() => teamPrivateChatsLineDue(team.id, typeof localStorage === "undefined" ? null : localStorage));
  if (!due) return null;
  return <p role="status" data-team-private-chats className="mx-5 mb-2 text-[13px] text-ink-secondary">{t("team.privateChats", { team: team.name })}</p>;
}
