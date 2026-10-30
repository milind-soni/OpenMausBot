import type { Bot, Group } from "@/state/store";
import { effectiveDefaultResponder, groupComposerHint } from "@/lib/group-routing";
import { t } from "@/lib/i18n";
import { BOT_BUTTON, botButtonStyle, botButtonTone, type BotButton } from "@/lib/bot-button";

/** Simple mode's small round controls in the composer: the +, the mic and Stop beside the round button. */
export const SIMPLE_CONTROL = "size-7 rounded-full bg-ink/[0.05] ring-[0.5px] ring-inset ring-ink/[0.07] text-ink-tertiary hover:bg-ink/[0.09] hover:text-ink";

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

export function composerPlaceholder({ simple, locked, approval, attaching, listening, replying, busy, canSteer, queued, busyName, sendLabel, group, members, jevOn, goal, botName, setupHint }: {
  simple: boolean;
  locked: boolean;
  approval: boolean;
  attaching: boolean;
  listening: boolean;
  replying: boolean;
  busy: boolean;
  canSteer: boolean;
  queued: boolean;
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
  if (simple) {
    if (!busy && goal) return group ? t("composer.placeholder.goal", { name: group.name }) : t("composer.placeholder.goalSolo", { name: botName });
    if (!busy && !group && setupHint) return setupHint;
    if (group && !group.dm && effectiveDefaultResponder(group, members).kind === "mentions") {
      return t("composer.placeholder.group", { name: group.name, hint: t("composer.hint.mentions") });
    }
    return t("composer.placeholder.bot", { name: group ? group.name : botName });
  }
  if (busy && canSteer) {
    return queued
      ? t("composer.placeholder.steerQueued", { name: busyName, key: sendLabel })
      : t("composer.placeholder.steer", { name: busyName, key: sendLabel });
  }
  if (busy) {
    return group
      ? t("composer.placeholder.queueGroup", { name: busyName, key: sendLabel })
      : t("composer.placeholder.queue", { name: busyName });
  }
  if (group) {
    return goal
      ? t("composer.placeholder.goal", { name: group.name })
      : t("composer.placeholder.group", { name: group.name, hint: groupComposerHint(group, members, { jevOn }) });
  }
  return setupHint ?? t(goal ? "composer.placeholder.goalSolo" : "composer.placeholder.bot", { name: botName });
}

/** The round Send button's name: what pressing it does now. Simple mode says it in the bot's terms. */
export function sendLabels({ simple, busy, canSteer, name, sendLabel }: { simple: boolean; busy: boolean; canSteer: boolean; name: string; sendLabel: string }): { label: string; title: string } {
  if (busy && canSteer) {
    const steer = simple ? t("composer.send.steerSimple", { name }) : t("composer.send.steer");
    return { label: steer, title: steer };
  }
  if (busy) {
    return simple
      ? { label: t("composer.send.queueSimple", { name }), title: t("composer.send.queueSimple", { name }) }
      : { label: t("composer.send.queue"), title: t("composer.send.queueHint") };
  }
  return { label: t("composer.send.message"), title: `${t("chat.send")} (${sendLabel})` };
}
