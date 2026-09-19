import { Loader2, Trash2 } from "lucide-react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export type BotConfirmKind = "archive" | "delete";

/** A confirmation may span live fleet updates; never authorize from its snapshot. */
export function currentArchivableBot(bots: readonly Bot[], id: string): Bot | undefined {
  const active = bots.filter((candidate) => !candidate.hidden);
  if (active.length <= 1) return undefined;
  return active.find((candidate) => candidate.id === id && !candidate.chiefOfStaff);
}

/** Copy for the archive / delete confirmation dialogs. Archiving keeps
 * everything and is reversible from Archived bots; deleting is not — the
 * server drops every task transcript, the workspace (files + memory), staged
 * skill state, and any private computer the bot owns. Shared team computers
 * remain. */
export function botConfirmCopy(kind: BotConfirmKind, name: string) {
  return kind === "archive"
    ? {
        title: t("sidebar.confirm.archiveTitle", { name }),
        body: t("sidebar.confirm.archiveBody", { name }),
        confirmLabel: t("sidebar.bot.archive"),
        tone: "neutral" as const,
      }
    : {
        title: t("sidebar.confirm.deleteTitle", { name }),
        body: t("sidebar.confirm.deleteBody", { name }),
        confirmLabel: t("common.delete"),
        tone: "danger" as const,
      };
}

export function archivedDeleteAllCopy() {
  return {
    title: t("sidebar.archived.deleteAllTitle"),
    body: t("sidebar.archived.deleteAllBody"),
    confirmLabel: t("sidebar.archived.deleteAll"),
    tone: "danger" as const,
  };
}

export function BotDeleteMenuItem({ deleting, onClick }: { deleting: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={deleting}
      aria-busy={deleting || undefined}
      onClick={onClick}
      title={deleting ? t("sidebar.bot.deleteCheckingTitle") : undefined}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger",
        deleting ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
      {deleting ? t("sidebar.bot.deleteChecking") : t("common.delete")}
    </button>
  );
}

