import { useEffect, useId, useState } from "react";
import { ChevronDown, Loader2, PackageOpen, RefreshCw, Rocket } from "lucide-react";
import type { HistoryItem } from "@/lib/announcement-history";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { notesAsMarkdown } from "@/lib/release-highlights";
import type { UpdaterState } from "@/lib/updater";
import { compareVersions } from "../../../shared/announcements";
import { releaseFromMarkdown, releaseLeads, releaseLineParts, type ReleaseEntry } from "../../../shared/release-notes";
import { PRIMARY_BUTTON } from "../NoticeCard";

export const MARK_TILE = "flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink/[0.05] text-ink-secondary";
export const QUIET_BUTTON = "ui-button min-h-9 gap-1.5 px-3 py-1.5";
export const DATE_TEXT = "block text-[12px] leading-4 text-ink-tertiary";
export const TITLE_TEXT = "mt-0.5 block text-[14px] font-medium leading-5 text-ink";
export const BODY_TEXT = "mt-0.5 line-clamp-2 block text-[13px] leading-[18px] text-ink-secondary";
export const CHIP = "rounded-full bg-ink/[0.06] px-2.5 py-1 text-[12px] text-ink-secondary";

const bare = (version: string) => version.trim().replace(/^v/i, "");
const sameVersion = (a: string, b: string) => compareVersions(bare(a), bare(b)) === 0;

/** What the Announcements page knows of this app's own version and its updater. */
export interface ReleaseContext {
  /** The version running here. */
  installed: string;
  /** The updater, when it has an update downloaded and waiting for a restart. */
  updater: UpdaterState | null;
}

/** An update downloaded and waiting for a restart, with its notes as an entry (for a row when the list lacks it). */
export function downloadedUpdate(state: UpdaterState | null, now: number): { version: string; notes: ReleaseEntry } | null {
  if (state?.status !== "downloaded" || !state.version) return null;
  const version = bare(state.version);
  return { version, notes: releaseFromMarkdown(notesAsMarkdown(state.releaseNotes ?? ""), { version, date: new Date(now).toISOString() }) };
}

/** A line of the notes: its words, with **bold** and `code` drawn as such, and nothing else read from it. */
function Line({ text }: { text: string }) {
  return <>{releaseLineParts(text).map((part, index) => {
    const words = part.code ? <code className="rounded bg-ink/[0.06] px-1 font-mono text-[12px]">{part.text}</code> : part.text;
    return part.bold ? <strong key={index} className="font-medium text-ink">{words}</strong> : <span key={index}>{words}</span>;
  })}</>;
}

/** Restart into the downloaded update, as the update card's own button does (installUpdate). */
function RestartButton({ updater, onRestart }: { updater: UpdaterState; onRestart: () => void }) {
  const [pending, setPending] = useState(false);
  useEffect(() => setPending(false), [updater.status]);
  const handoff = updater.installMode === "handoff";
  const busy = pending || updater.status === "installing";
  const label = busy ? handoff ? t("settings.updates.opening") : t("settings.updates.restartingShort") : handoff ? t("settings.updates.install") : t("update.card.restart");
  const Icon = busy ? Loader2 : handoff ? PackageOpen : RefreshCw;
  return <button type="button" data-release-restart className={PRIMARY_BUTTON} disabled={busy} onClick={() => { setPending(true); onRestart(); }}>
    <Icon size={14} aria-hidden className={cn(busy && "animate-spin")} />{label}
  </button>;
}

/** One release in the Announcements list: its date, "What's new in" its version, the leads of its first two lines, and
 * the whole notes behind See all changes. The version running here says so; a downloaded update offers its restart. */
export function ReleaseRow({ item, date, context, onRestart }: {
  item: Extract<HistoryItem, { source: "release" }>; date: string; context: ReleaseContext; onRestart: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const { release } = item;
  const current = sameVersion(release.version, context.installed);
  const ready = context.updater?.status === "downloaded" && !!context.updater.version && sameVersion(release.version, context.updater.version) ? context.updater : null;
  const leads = releaseLeads(release).join(" ");
  const hasNotes = release.sections.length > 0;
  return <li data-announcement-item={item.id} data-release={release.version} className="flex items-start gap-3 px-3 py-3">
    <span aria-hidden="true" className={MARK_TILE}><Rocket size={18} /></span>
    <div className="min-w-0 flex-1">
      <time dateTime={new Date(item.at).toISOString()} className={DATE_TEXT}>{date}</time>
      <span className={TITLE_TEXT}>{t("announcements.release.title", { version: release.version })}</span>
      {leads && <span className={BODY_TEXT}>{leads}</span>}
      {(ready || hasNotes || current) && <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {ready && <RestartButton updater={ready} onRestart={onRestart} />}
        {hasNotes && <button type="button" className={QUIET_BUTTON} aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)}>
          {t(open ? "announcements.release.hide" : "announcements.release.seeAll")}
          <ChevronDown size={14} aria-hidden className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </button>}
        {current && <span data-release-current className={CHIP}>{t("announcements.release.current")}</span>}
      </div>}
      {open && <div id={panel} data-release-notes className="mt-3 flex flex-col gap-3">
        {release.sections.map((section, index) => <section key={index}>
          <h3 className="text-[13px] font-medium leading-[18px] text-ink">{section.title}</h3>
          <ul className="mt-1 flex list-disc flex-col gap-1 ps-4 text-[13px] leading-[18px] text-ink-secondary">
            {section.items.map((line, index) => <li key={index}><Line text={line} /></li>)}
          </ul>
        </section>)}
      </div>}
    </div>
  </li>;
}
