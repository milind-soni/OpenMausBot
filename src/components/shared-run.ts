
import { shownPersonName } from "../../shared/bot-owner";
import type { ResolvedSender } from "../../shared/wire";
import { useReactor } from "@/lib/cloud-guest";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";

/** The working line's lead in a conversation several people write in: whose request runs. */
export function workingForLabel(askedBy: ResolvedSender | undefined, viewer: string): string | undefined {
  if (!askedBy) return undefined;
  return askedBy.id === viewer ? t("chat.queue.workingForYou") : t("chat.queue.workingFor", { name: shownPersonName(askedBy.name) });
}

/** Where several people write, whether the viewer may stop or retry what `asker` asked: their own, a run no person
 * asked for, or any as an Owner or Admin (shown while that is still unknown; the server refuses the rest). */
export function mayActOn(asker: ResolvedSender | undefined, viewer: string, admin: boolean | null): boolean {
  return !asker?.id || asker.id === viewer || admin !== false;
}

export function useMayAct(): (asker: ResolvedSender | undefined) => boolean {
  const viewer = useReactor();
  const admin = useOwnerOrAdmin();
  return (asker) => mayActOn(asker, viewer, admin);
}

export function useSharedRun(bot: Bot): { label?: string; mayAct: (asker: ResolvedSender | undefined) => boolean } {
  const team = useStoreSelector((state) => Boolean(state.config?.team));
  const viewer = useReactor();
  const mayAct = useMayAct();
  const task = team ? bot.tasks?.find((one) => one.threadId === bot.threadId && !one.private) : undefined;
  if (!task) return { mayAct: () => true };
  return {
    label: workingForLabel(task.askedBy, viewer),
    mayAct,
  };
}
