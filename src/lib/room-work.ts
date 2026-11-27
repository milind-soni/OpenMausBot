import type { BoardItem } from "../../shared/board";
import { t } from "@/lib/i18n";

/** Where a room thread's piece of work stands, in a few words: shown on its feed row and over it when it is open. Only a
 * thread a bot split off as work (a board item, docs/team-board.md) has one. */
export interface WorkStatus {
  kind: "next" | "working" | "needs" | "done" | "stopped";
  label: string;
  /** `needs` only: it waits on someone else, so it does not wait on the viewer. */
  someoneElse?: true;
}

/** Hierarchy from ink: what waits on a person reads first, a bot at work next, the rest quietly. */
export const WORK_INK: Record<WorkStatus["kind"], string> = {
  needs: "font-medium text-ink",
  working: "text-ink-secondary",
  next: "text-ink-tertiary",
  done: "text-ink-tertiary",
  stopped: "text-ink-tertiary",
};

/** The one status a work item shows. `viewer` is the viewer's person key, as `question.person` names whoever was asked:
 * a question to nobody in particular is for whoever sees it. A cancelled item shows nothing. */
export function workStatus(item: BoardItem | undefined, viewer: string | null, botName: (botId: string) => string | undefined): WorkStatus | null {
  if (!item) return null;
  switch (item.state) {
    case "waiting":
    case "ready":
      return { kind: "next", label: t("room.work.upNext") };
    case "working": {
      const name = item.holder ? botName(item.holder.botId) : undefined;
      return { kind: "working", label: name ? t("room.work.botWorking", { name }) : t("room.work.working") };
    }
    case "needs_person": {
      const asked = item.question?.person;
      if (!asked || asked === viewer) return { kind: "needs", label: t("room.work.needsYou") };
      const name = item.question?.name?.trim();
      return { kind: "needs", label: name ? t("room.work.needsName", { name }) : t("room.work.needsAnswer"), someoneElse: true };
    }
    case "done":
      return { kind: "done", label: t("room.work.done") };
    case "failed":
      return { kind: "stopped", label: t("room.work.stopped") };
    case "cancelled":
      return null;
  }
}
