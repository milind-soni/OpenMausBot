import { Crown } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";

export function SidebarBotRole({ role }: { role: string }) {
  return (
    <span data-testid="bot-role" className="@container -ms-1.5 min-w-0 grow">
      <span title={role} className="block truncate ps-1.5 text-[13px] font-normal leading-[18px] text-ink-secondary @max-[3rem]:sr-only">
        <span className="sr-only">, </span>{role}
      </span>
    </span>
  );
}

export function ChatHeadRole({ bot }: { bot: Pick<Bot, "title" | "chiefOfStaff"> }) {
  const role = bot.title.trim();
  const repeatsChiefBadge = bot.chiefOfStaff && role.toLocaleLowerCase() === t("chat.chiefOfStaff").toLocaleLowerCase();
  if (!role || repeatsChiefBadge) return null;
  return (
    <span data-chathead-role className="flex min-w-0 max-w-fit grow basis-0">
      <span title={role} className="max-w-[16rem] truncate text-[13px] text-ink-secondary">{role}</span>
    </span>
  );
}

export function chiefOfStaffBadge(bot: Bot) {
  if (!bot.chiefOfStaff) return null;
  return (
    <span title={t("chat.chiefOfStaff")} className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent @max-4xl/chathead:px-1.5">
      <Crown size={11} aria-hidden="true" /> <span className="@max-4xl/chathead:sr-only">{t("chat.chiefOfStaff")}</span>
    </span>
  );
}
