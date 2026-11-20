import type { Bot, Group } from "@/state/store";
import { groupComposerHint } from "@/lib/group-routing";
import { t } from "@/lib/i18n";
import { BOT_BUTTON, botButtonStyle, botButtonTone, type BotButton } from "@/lib/bot-button";

/** Simple mode's small round controls in the composer: the +, the mic and Stop beside the round button. */
export const SIMPLE_CONTROL = "size-7 rounded-full bg-ink/[0.05] ring-[0.5px] ring-inset ring-ink/[0.07] text-ink-tertiary interaction:bg-raised/50 hover:text-ink";

const ROOM_FILL = { fill: "var(--color-accent)", ink: "var(--color-accent-ink)" };

/** The round call, Send and Stop button: the bot's own button, or the accent in a room. */
export function slotColors(color: Bot["color"] | undefined, room: boolean): { fill: string; ink: string; button: BotButton } {
  if (room) {
    return { ...ROOM_FILL, button: { className: "hover:brightness-110 disabled:opacity-40", style: { backgroundColor: ROOM_FILL.fill, color: ROOM_FILL.ink } } };
  }
  const own = color ?? "green";
  const tone = botButtonTone(own);
  return { fill: tone.fill, ink: tone.ink, button: { className: BOT_BUTTON, style: botButtonStyle(own) } };
}

export function composerPlaceholder({ locked, approval, attaching, listening, replying, busy, busyName, sendLabel, group, members, jevOn, goal, botName, setupHint }: {
  locked: boolean;
  approval: boolean;
  attaching: boolean;
  listening: boolean;
  replying: boolean;
  busy: boolean;
  busyName: string;
  sendLabel: string;
  group?: Group;
  members: Bot[];
  jevOn: boolean;
  goal: boolean;
  botName: string;
  setupHint: string | null | undefined;
}): string {
  if (locked) return t("composer.placeholder.locked");
  if (approval) return t("composer.placeholder.approval");
  if (attaching) return t("composer.placeholder.attaching");
  if (listening) return t("composer.placeholder.listening");
  if (replying && !busy) return t("composer.placeholder.reply");
  if (busy) return t("composer.placeholder.working", { name: busyName, key: sendLabel });
  if (group) {
    return goal
      ? t("composer.placeholder.goal", { name: group.name })
      : t("composer.placeholder.group", { name: group.name, hint: groupComposerHint(group, members, { jevOn }) });
  }
  return setupHint ?? t(goal ? "composer.placeholder.goalSolo" : "composer.placeholder.bot", { name: botName });
}
