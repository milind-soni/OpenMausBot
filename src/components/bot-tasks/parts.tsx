import { ArrowUpRight, GitPullRequest, CircleDot } from "lucide-react";

import type { BotTaskGithubRef, BotTaskStatus } from "../../../shared/bot-tasks";
import { githubRefHref, githubRefLabel, STATUS_LABEL } from "@/lib/bot-tasks";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";

const STATUS_TONE: Record<BotTaskStatus, string> = {
  open: "bg-ink/[0.06] text-ink-secondary",
  in_progress: "bg-ink/[0.06] text-ink",
  blocked: "bg-warning/15 text-ink",
  review: "bg-ink/[0.06] text-ink",
  done: "bg-success/15 text-ink",
  cancelled: "bg-ink/[0.04] text-ink-tertiary",
};
const STATUS_DOT: Partial<Record<BotTaskStatus, string>> = { blocked: "bg-warning", done: "bg-success", in_progress: "bg-ink-secondary", review: "bg-ink-secondary" };

export function StatusChip({ status }: { status: BotTaskStatus }) {
  const dot = STATUS_DOT[status];
  return (
    <span data-bot-task-status={status} className={cn("ui-chip shrink-0", STATUS_TONE[status])}>
      {dot && <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dot)} />}
      {t(STATUS_LABEL[status])}
    </span>
  );
}

/** `owner/repo#12` linking to the pull request or issue on github.com; plain text when the ref can't be a GitHub address. */
/** `compact` drops the owner (gadgets#372 for acme/gadgets#372) where a narrow card would cut the number off. */
export function GithubRefChip({ githubRef, compact }: { githubRef: BotTaskGithubRef; compact?: boolean }) {
  const href = githubRefHref(githubRef);
  const Icon = githubRef.kind === "pull" ? GitPullRequest : CircleDot;
  const body = <>
    <Icon size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
    <span className="truncate" dir="ltr" title={compact ? githubRefLabel(githubRef) : undefined}>{compact ? `${githubRef.repo.split("/").pop()}#${githubRef.number}` : githubRefLabel(githubRef)}</span>
  </>;
  if (!href) return <span data-bot-task-ref="" className="ui-chip min-w-0 border border-hairline/40 text-ink-secondary">{body}</span>;
  return (
    <a data-bot-task-ref="" href={href} target="_blank" rel="noopener noreferrer" title={t("botTasks.openOnGithub")}
      className="ui-chip min-w-0 border border-hairline/40 text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink motion-reduce:transition-none">
      {body}
    </a>
  );
}

/** A link out to github.com, for a URL already checked by `githubHref`. */
export function GithubLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-0.5 text-accent-text hover:underline focus-visible:underline">
      <span className="truncate">{children}</span>
      <ArrowUpRight size={12} aria-hidden="true" className="shrink-0" />
    </a>
  );
}

export function fullTime(at: number): string {
  return new Date(at).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
}

export function When({ at }: { at: number }) {
  return <time dateTime={new Date(at).toISOString()} title={fullTime(at)} className="shrink-0 text-[12px] font-medium leading-4 tabular-nums text-ink-tertiary">{relativeTime(at)}</time>;
}
