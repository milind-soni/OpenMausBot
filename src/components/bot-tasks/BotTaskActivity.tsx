import type { ReactNode } from "react";

import { Check, Minus, X } from "lucide-react";

import type { BotTaskActivity, BotTaskActor, BotTaskEvidence, BotTaskVerification } from "../../../shared/bot-tasks";
import { evidenceView, githubHref, githubRefLabel, STATUS_LABEL } from "@/lib/bot-tasks";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { fullTime, GithubLink, When } from "./parts";
import { TaskMarkdown } from "./TaskMarkdown";

export function actorName(actor: BotTaskActor): string {
  switch (actor.kind) {
    case "bot": return actor.name || actor.id;
    case "person": return actor.name;
    case "github": return actor.login;
    case "system": return t("botTasks.actor.system");
  }
}

const FROM_GITHUB = new Set<BotTaskActivity["type"]>(["github_comment", "github_review", "github_check", "github_state"]);

/** One piece of proof, as words a person reads: the short commit, the CI run or review as a GitHub link, the command
 * and how it exited, and what the app's own check on GitHub found, when it made one (older entries have none). */
export function EvidenceItem({ evidence, taskRepo }: { evidence: BotTaskEvidence; taskRepo?: string }) {
  const check = evidence.kind === "command" && evidence.verification?.status === "unverifiable"
    ? { ...evidence.verification, detail: `Self-reported exit code ${evidence.exitCode}, not independently checked.` }
    : evidence.verification;
  return (
    <li data-evidence={evidence.kind} data-verification={check?.status} className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <EvidenceClaim evidence={evidence} taskRepo={taskRepo} />
        {check && <VerificationBadge verification={check} />}
      </div>
      {check && (
        <p data-verification-line="" dir="auto" className={cn("text-[12px] leading-4", check.status === "failed" ? "text-danger" : "text-ink-tertiary")}>
          {check.detail ? `${check.detail} · ` : ""}{t("botTasks.verification.checked", { time: fullTime(check.checkedAt) })}
        </p>
      )}
    </li>
  );
}

const VERIFICATION: Record<BotTaskVerification["status"], { label: LocaleKey; tone: string; Icon: typeof Check }> = {
  verified: { label: "botTasks.verification.verified", tone: "bg-success/15 text-ink", Icon: Check },
  failed: { label: "botTasks.verification.failed", tone: "bg-danger/15 text-danger", Icon: X },
  unverifiable: { label: "botTasks.verification.unverifiable", tone: "bg-ink/[0.06] text-ink-secondary", Icon: Minus },
};

/** What the app found when it looked the claim up on GitHub. Failed reads as an error; not verifiable stays neutral. */
export function VerificationBadge({ verification, bare = false }: { verification: BotTaskVerification; bare?: boolean }) {
  const { label, tone, Icon } = VERIFICATION[verification.status];
  const checked = t("botTasks.verification.checked", { time: fullTime(verification.checkedAt) });
  // `bare`: only the outcome is known (a board card), so no check time is claimed.
  const title = bare ? undefined : verification.detail ? `${verification.detail}\n${checked}` : checked;
  return (
    <span data-verification-badge={verification.status} title={title} className={cn("ui-chip shrink-0", tone)}>
      <Icon size={12} aria-hidden="true" className="shrink-0" />
      {t(label)}
    </span>
  );
}

function EvidenceClaim({ evidence, taskRepo }: { evidence: BotTaskEvidence; taskRepo?: string }) {
  const view = evidenceView(evidence, taskRepo);
  switch (view.kind) {
    case "commit": {
      const sha = <code className="ui-code-chip" dir="ltr">{view.sha}</code>;
      return <>
        <span className="text-ink-secondary">{t("botTasks.evidence.commit")}</span>
        {view.href ? <GithubLink href={view.href}>{sha}</GithubLink> : sha}
        {view.repo && <span className="truncate text-ink-tertiary" dir="ltr">{view.repo}</span>}
      </>;
    }
    case "ci_run":
    case "review_url": {
      const label = t(view.kind === "ci_run" ? "botTasks.evidence.ciRun" : "botTasks.evidence.review");
      return view.href ? <GithubLink href={view.href}>{label}</GithubLink> : <>
        <span className="text-ink-secondary">{label}</span>
        <span className="min-w-0 truncate text-ink-tertiary" dir="ltr">{view.text}</span>
      </>;
    }
    case "command":
      return <>
        <code className="ui-code-chip min-w-0 break-all" dir="ltr">{view.command}</code>
        <span className={cn("font-medium tabular-nums", view.ok ? "text-ink-secondary" : "text-danger")}>{t("botTasks.evidence.exit", { code: view.exitCode })}</span>
      </>;
  }
}

function Quote({ text }: { text: string }) {
  // Text from bots and from GitHub reads as it does on GitHub: Markdown plus GitHub's sanitized HTML allowlist.
  return <TaskMarkdown text={text} className="mt-1 rounded-xl border border-hairline/40 px-3 py-2" />;
}

function line(entry: BotTaskActivity, who: string, ownerName: (id: string) => string, taskRepo?: string): { text: string; body?: ReactNode; link?: string } {
  switch (entry.type) {
    case "created": return { text: t("botTasks.activity.created", { who }) };
    case "comment": return { text: t("botTasks.activity.comment", { who }), body: <Quote text={entry.text} /> };
    case "status": return {
      text: t("botTasks.activity.status", { who, from: t(STATUS_LABEL[entry.from]), to: t(STATUS_LABEL[entry.to]) }),
      body: entry.evidence?.length ? (
        <ul aria-label={t("botTasks.evidence.title")} className="mt-1 flex flex-col gap-1 text-[13px] leading-[18px]">
          {entry.evidence.map((evidence, index) => <EvidenceItem key={index} evidence={evidence} taskRepo={taskRepo} />)}
        </ul>
      ) : undefined,
    };
    case "owner": return { text: entry.from ? t("botTasks.activity.ownerMoved", { who, from: ownerName(entry.from), to: ownerName(entry.to) }) : t("botTasks.activity.owner", { who, to: ownerName(entry.to) }) };
    case "github_ref": return { text: t("botTasks.activity.linked", { who, ref: githubRefLabel(entry.ref) }) };
    case "github_comment": return { text: t("botTasks.activity.githubComment", { who }), body: <Quote text={entry.text} />, link: entry.url };
    case "github_review": return { text: t("botTasks.activity.githubReview", { who, state: entry.state.toLowerCase().replaceAll("_", " ") }), body: entry.text ? <Quote text={entry.text} /> : undefined, link: entry.url };
    case "github_check": return { text: t("botTasks.activity.githubCheck", { name: entry.name, conclusion: entry.conclusion.toLowerCase().replaceAll("_", " ") }), link: entry.url };
    case "github_state": return { text: t(entry.state === "merged" ? "botTasks.activity.merged" : entry.state === "closed" ? "botTasks.activity.closed" : "botTasks.activity.reopened"), link: entry.url };
    case "posted": return { text: t(entry.merged ? "botTasks.activity.postedMerged" : "botTasks.activity.posted", { who }), link: entry.url };
    case "sync_error": return { text: t("botTasks.activity.syncError"), body: <p dir="auto" className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-[18px] text-danger">{entry.text}</p> };
  }
}

/** An imported entry's own GitHub time, spelled out: it can be long before the task, so "3 months ago" alone would mislead. */
function OriginalTime({ at }: { at: number }) {
  const time = fullTime(at);
  return <time data-original-time="" dateTime={new Date(at).toISOString()} title={t("botTasks.importedAt", { time })}
    className="shrink-0 text-[12px] font-medium leading-4 tabular-nums text-ink-tertiary">{time}</time>;
}

/** A task's log, oldest first, the way it happened. What GitHub said is marked as coming from GitHub. */
export function BotTaskActivityList({ activity, taskRepo, ownerName = (id) => id }: {
  activity: readonly BotTaskActivity[];
  taskRepo?: string;
  ownerName?: (id: string) => string;
}) {
  const ordered = [...activity].sort((a, b) => a.at - b.at);
  return (
    <ol aria-label={t("botTasks.activity.title")} className="flex flex-col">
      {ordered.map((entry) => {
        const imported = entry.imported === true;
        const external = imported || FROM_GITHUB.has(entry.type);
        const { text, body, link } = line(entry, actorName(entry.by), ownerName, taskRepo);
        const href = githubHref(link);
        return (
          <li key={entry.id} data-activity={entry.type} data-from-github={external ? "" : undefined} data-imported={imported ? "" : undefined}
            className={cn("flex flex-col border-t border-hairline/40 py-3 first:border-t-0", external && "border-s-2 border-s-ink/15 ps-3")}>
            <div className="flex min-w-0 items-baseline gap-2">
              <p dir="auto" className="min-w-0 flex-1 text-[13px] leading-[18px] text-ink">
                {external && <span data-github-badge={imported ? "imported" : "live"} className="ui-chip me-1.5 bg-ink/[0.06] align-[1px] text-ink-secondary">{t(imported ? "botTasks.imported" : "botTasks.fromGithub")}</span>}
                {text}
              </p>
              {imported ? <OriginalTime at={entry.at} /> : <When at={entry.at} />}
            </div>
            {body}
            {href && <span className="mt-1 text-[12px] leading-4"><GithubLink href={href}>{t("botTasks.viewOnGithub")}</GithubLink></span>}
          </li>
        );
      })}
    </ol>
  );
}
