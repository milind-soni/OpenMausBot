// Memory: what this bot believes, as a panel a person can read, fix, and
// audit. Four regions: where the folder is (open it in Obsidian or the
// file manager — it is plain markdown), a gauge that says out loud what
// loadMemory() cuts silently, an editor for MEMORY.md and the topic files
// that refuses to overwrite what the bot wrote while the person was
// typing, and the journal of every change with one-click undo.
//
// Fetched when the section becomes active, not on mount: settings opens
// for every bot and most visits never look at memory — and a re-activation
// re-reads, so notes the bot wrote mid-session show up on the next look.
// The dialog keeps this mounted while hidden so an unsaved draft survives
// a visit to another section.
import { FileText, FolderOpen, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import {
  MEMORY_INDEX,
  capacityStatus,
  deleteMemoryDoc,
  fetchMemoryDoc,
  fetchMemoryJournal,
  fetchMemoryOverview,
  fileManagerLabel,
  formatBytes,
  journalSource,
  journalSummary,
  openMemoryLocation,
  relativeTime,
  revertMemoryChange,
  saveMemoryDoc,
  fetchUpkeepStatus,
  tidyMemoryNow,
  tidySummary,
  noticedCount,
  topicFileName,
  type UpkeepStatus,
  type MemoryCapacity,
  type MemoryFileInfo,
  type MemoryJournalRow,
  type MemoryOverview,
  type LendingReview,
  markMemoryReviewed,
} from "@/lib/memory";
import { shortPath } from "@/lib/short-path";
import { t } from "@/lib/i18n";
import { ApiError, useStore, type Bot } from "@/state/store";
import { Switch } from "../SettingsPrimitives";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { inputCls } from "./field";

const buttonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50";
const quietButtonCls = "rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";

interface Editing {
  path: string;
  text: string;
  /** sha256 the server reported when the text was loaded; sent back on save. */
  hash: string;
  dirty: boolean;
  readOnly: boolean;
}

interface Conflict {
  path: string;
  /** What is on disk now — the bot's version. */
  current: string;
  currentHash: string;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** On an OMB Cloud home: this bot's memory changed in a conversation the
 * owner did not write, so its turns cannot use the owner's lent Mac until
 * the owner has looked. It names the files that changed; one click accepts
 * them as shown (no confirmation), and the server refuses it if anything
 * changed since. */
export function LendingReviewNotice({ changed, stale, busy, onReviewed }: { changed: readonly string[]; stale: boolean; busy: boolean; onReviewed: () => void }) {
  return (
    <div role="status" className="rounded-xl border border-danger/40 bg-card p-4">
      <p className="text-[13px] leading-relaxed text-ink">{t(stale ? "memory.lendingReviewStale" : "memory.lendingReview")}</p>
      {changed.length > 0 && (
        <>
          <p className="mt-2 text-[12px] text-ink-secondary">{t("memory.lendingReviewChanged")}</p>
          <ul className="mt-1 space-y-0.5">
            {changed.map((file) => (
              <li key={file} className="break-all font-mono text-[12px] text-ink">{file}</li>
            ))}
          </ul>
        </>
      )}
      <button type="button" className={cn(buttonCls, "mt-3")} disabled={busy} onClick={onReviewed}>
        {t("memory.lendingReviewed")}
      </button>
    </div>
  );
}

export function MemorySection({ bot, active = true, onToggle }: { bot: Bot; active?: boolean; onToggle: (enabled: boolean) => void }) {
  const { capabilities } = useDesktopCapabilities();
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [journal, setJournal] = useState<MemoryJournalRow[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);
  const [newTopic, setNewTopic] = useState("");
  const [upkeep, setUpkeep] = useState<UpkeepStatus | null>(null);
  const [tidying, setTidying] = useState(false);
  // OMB Cloud home: memory changed where the owner did not write.
  const [lendingReview, setLendingReview] = useState<LendingReview | null>(null);
  const [lendingReviewStale, setLendingReviewStale] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const { dispatch } = useStore();

  const refresh = async (openPath?: string) => {
    const [nextOverview, nextJournal, nextUpkeep] = await Promise.all([
      fetchMemoryOverview(bot.id),
      fetchMemoryJournal(bot.id),
      fetchUpkeepStatus(bot.id).catch(() => null),
    ]);
    setOverview(nextOverview);
    setLendingReview(nextOverview.lendingReview ?? null);
    setJournal(nextJournal);
    setUpkeep(nextUpkeep);
    if (openPath) {
      const doc = await fetchMemoryDoc(bot.id, openPath);
      setEditing({ path: doc.path, text: doc.text, hash: doc.hash, dirty: false, readOnly: openPath.startsWith("memory/log/") });
    }
  };

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setError(null);
    // a dirty draft survives a re-activation; everything else re-reads
    const keepDraft = editing?.dirty === true;
    refresh(keepDraft ? undefined : (editing?.path ?? MEMORY_INDEX)).catch((e: unknown) => {
      if (!cancelled) setError(errorText(e));
    });
    return () => {
      cancelled = true;
    };
  }, [active, bot.id]);

  const open = async (path: string) => {
    setError(null);
    setConflict(null);
    try {
      const doc = await fetchMemoryDoc(bot.id, path);
      setEditing({ path: doc.path, text: doc.text, hash: doc.hash, dirty: false, readOnly: path.startsWith("memory/log/") });
    } catch (e) {
      setError(errorText(e));
    }
  };

  const save = async (expectedHash: string | undefined) => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveMemoryDoc(bot.id, editing.path, editing.text, expectedHash);
      if (!result.ok) {
        setConflict({ path: editing.path, current: result.current, currentHash: result.currentHash });
        return;
      }
      setConflict(null);
      setSavedDraft(null);
      setEditing({ ...editing, text: result.doc.text, hash: result.doc.hash, dirty: false });
      setOverview(result.overview);
      setJournal(await fetchMemoryJournal(bot.id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  /** Reload keeps the person's words: the draft moves under the editor
   * as read-only text so nothing typed is lost, and the editor shows the
   * bot's version. */
  const reloadFromConflict = () => {
    if (!conflict || !editing) return;
    setSavedDraft(editing.text);
    setEditing({ ...editing, text: conflict.current, hash: conflict.currentHash, dirty: false });
    setConflict(null);
  };

  const remove = async (file: MemoryFileInfo) => {
    if (!window.confirm(t("memory.confirmDelete", { name: file.name }))) return;
    setError(null);
    try {
      const { overview: next } = await deleteMemoryDoc(bot.id, file.path);
      setOverview(next);
      setJournal(await fetchMemoryJournal(bot.id));
      if (editing?.path === file.path) setEditing(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const createTopic = async () => {
    const name = topicFileName(newTopic);
    if (!name) {
      setError(t("memory.topicNameError"));
      return;
    }
    setNewTopic("");
    await open(`memory/${name}`);
    setEditing((current) => (current ? { ...current, dirty: true, text: current.text || topicTemplate(name) } : current));
  };

  const revert = async (row: MemoryJournalRow) => {
    setReverting(row.id);
    setError(null);
    try {
      const result = await revertMemoryChange(bot.id, row.id);
      setOverview(result.overview);
      setJournal(await fetchMemoryJournal(bot.id));
      if (editing?.path === row.path && !editing.dirty) {
        setEditing({ ...editing, text: result.text, hash: result.hash });
      }
      setNotice(t("memory.putBackNotice", { path: row.path }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setReverting(null);
    }
  };

  const openLocation = async (target: "obsidian" | "folder") => {
    setError(null);
    setNotice(null);
    try {
      await openMemoryLocation(bot.id, target);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const toggleUpkeep = () => {
    const enabled = bot.memoryUpkeep === false;
    dispatch({ type: "updateBot", botId: bot.id, patch: { memoryUpkeep: enabled } });
    setUpkeep((current) => (current ? { ...current, enabled } : current));
  };

  const tidyNow = async () => {
    setTidying(true);
    setError(null);
    setNotice(null);
    try {
      const { report, overview: next } = await tidyMemoryNow(bot.id);
      setOverview(next);
      setJournal(await fetchMemoryJournal(bot.id));
      setUpkeep(await fetchUpkeepStatus(bot.id));
      if (editing && !editing.dirty) await open(editing.path);
      setNotice(`${tidySummary(report)}.${report.note ? ` ${report.note}` : ""}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setTidying(false);
    }
  };

  const home = capabilities.host.homeDir;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">{t("memory.title")}</div>
        <label className="mt-3 flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={bot.memoryEnabled !== false} disabled={bot.busy} onChange={(event) => onToggle(event.target.checked)} />
        {t("memory.useMemory")}
        </label>
        <p className="mt-1 text-[12.5px] text-ink-secondary">
          {t("memory.offStops")}
          {bot.busy ? ` ${t("memory.stopTurnFirst")}` : ""}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
          {t("memory.notesDescription")}
        </p>
        {overview && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-secondary" title={overview.workspacePath}>
              {shortPath(overview.workspacePath, home)}
            </span>
            <button type="button" className={buttonCls} onClick={() => void openLocation("obsidian")}>
            {t("memory.openInObsidian")}
            </button>
            <button type="button" className={cn(buttonCls, "inline-flex items-center gap-1.5")} onClick={() => void openLocation("folder")}>
              <FolderOpen size={14} />
              {fileManagerLabel(capabilities.host.platform)}
            </button>
          </div>
        )}
      </div>

      {lendingReview && (
        <LendingReviewNotice
          changed={lendingReview.changed}
          stale={lendingReviewStale}
          busy={reviewing}
          onReviewed={() => {
            setReviewing(true);
            markMemoryReviewed(bot.id, lendingReview.token)
              .then(() => { setLendingReview(null); setLendingReviewStale(false); })
              // Changed again since it was shown: show what is there now.
              .catch((e: unknown) => {
                if (e instanceof ApiError && e.status === 409) {
                  setLendingReviewStale(true);
                  return refresh();
                }
                setError(errorText(e));
              })
              .finally(() => setReviewing(false));
          }}
        />
      )}

      {overview && <MemoryGauge index={overview.index} />}

      {bot.memoryEnabled !== false && <MemoryUpkeepCard
        enabled={bot.memoryUpkeep !== false}
        status={upkeep}
        tidying={tidying}
        onToggle={toggleUpkeep}
        onTidy={() => void tidyNow()}
      />}

      {editing && (
        <div className="rounded-xl bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[12.5px] text-ink">{editing.path}</span>
            {editing.path !== MEMORY_INDEX && (
              <button type="button" className={quietButtonCls} onClick={() => void open(MEMORY_INDEX)}>
                {t("memory.backToMemoryMd")}
              </button>
            )}
          </div>
          {conflict && (
            <ConflictNotice
              botName={bot.name}
              busy={saving}
              onReload={reloadFromConflict}
              onOverwrite={() => void save(conflict.currentHash)}
            />
          )}
          <textarea
            className={cn(inputCls, "mt-2 min-h-[200px] resize-y font-mono text-[12.5px] leading-relaxed")}
            value={editing.text}
            readOnly={editing.readOnly}
            placeholder={editing.path === MEMORY_INDEX ? t("memory.indexPlaceholder") : t("memory.topicPlaceholder")}
            aria-label={editing.path === MEMORY_INDEX ? "Bot memory" : `Memory file ${editing.path}`}
            onChange={(e) => setEditing({ ...editing, text: e.target.value, dirty: true })}
          />
          {editing.readOnly ? (
            <p className="mt-2 text-[12px] text-ink-secondary">{t("memory.dailyLogsReadOnly")}</p>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <button type="button" onClick={() => void save(editing.hash)} disabled={saving || !editing.dirty} className={buttonCls}>
                {saving ? t("memory.saving") : t("memory.save")}
              </button>
              {editing.dirty && (
                <button type="button" className={quietButtonCls} disabled={saving} onClick={() => void open(editing.path)}>
                  {t("memory.discardChanges")}
                </button>
              )}
            </div>
          )}
          {savedDraft !== null && (
            <div className="mt-3">
              <div className="mb-1 text-[12px] text-ink-secondary">{t("memory.unsavedDraft")}</div>
              <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink">
                {savedDraft}
              </pre>
              <button type="button" className={cn(quietButtonCls, "mt-1")} onClick={() => setSavedDraft(null)}>
                {t("memory.dismissDraft")}
              </button>
            </div>
          )}
        </div>
      )}

      {overview && (
        <div className="rounded-xl bg-card p-4">
          <MemoryFileRows
            title={t("memory.topicFiles")}
            hint={t("memory.topicFilesHint")}
            files={overview.topics}
            selected={editing?.path}
            onOpen={(file) => void open(file.path)}
            onDelete={(file) => void remove(file)}
          />
          <div className="mt-3 flex items-center gap-2">
            <input
              className={cn(inputCls, "py-1.5 text-[13px]")}
              value={newTopic}
              placeholder={t("memory.newTopicName")}
              aria-label="New topic name"
              onChange={(e) => setNewTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createTopic();
              }}
            />
            <button type="button" className={buttonCls} disabled={!newTopic.trim()} onClick={() => void createTopic()}>
              {t("memory.newTopic")}
            </button>
          </div>
          {overview.logs.length > 0 && (
            <div className="mt-4">
              <MemoryFileRows
                title={t("memory.dailyLogs")}
                hint={t("memory.dailyLogsHint")}
                files={overview.logs}
                selected={editing?.path}
                onOpen={(file) => void open(file.path)}
                onDelete={(file) => void remove(file)}
              />
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("memory.changes")}</div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
          {t("memory.changesDescription")}
        </p>
        <div className="mt-3">
          <MemoryJournalList rows={journal} botName={bot.name} reverting={reverting} onRevert={(row) => void revert(row)} />
        </div>
      </div>

      {notice && <div className="text-[12.5px] text-ink-secondary">{notice}</div>}
      {error && <div className="text-[12.5px] text-danger">{error}</div>}
    </div>
  );
}

/** A new topic's starting text: the header the topic index and recall read,
 * so the other words a person would use for it are one line to fill in. */
export function topicTemplate(fileName: string): string {
  const title = fileName.replace(/\.md$/, "");
  return `---\ntitle: ${title}\ndescription: \naliases: []\n---\n\n`;
}

// ── presentational pieces (tested through renderToStaticMarkup) ─────────

export function MemoryUpkeepCard({
  enabled,
  status,
  tidying,
  onToggle,
  onTidy,
}: {
  enabled: boolean;
  status: UpkeepStatus | null;
  tidying: boolean;
  onToggle: () => void;
  onTidy: () => void;
}) {
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-medium text-ink">{t("memory.upkeepTitle")}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
            {t("memory.upkeepDescription")}
          </p>
        </div>
        <Switch checked={enabled} aria-label="Memory upkeep" onClick={onToggle} />
      </div>
      {enabled && status && !status.modelSteps && (
        <p className="mt-2 text-[12.5px] text-ink-secondary">
          {t("memory.upkeepNoModelSteps")}
        </p>
      )}
      {enabled && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className={buttonCls} disabled={tidying} onClick={onTidy}>
            {tidying ? t("memory.tidying") : t("memory.tidyUpNow")}
          </button>
          <span className="text-[12.5px] text-ink-secondary">
            {status?.lastTidy
              ? t("memory.lastTidy", { when: relativeTime(status.lastTidy.at), summary: tidySummary(status.lastTidy).toLowerCase() })
              : t("memory.notTidiedYet")}
            {status?.lastCapture && noticedCount(status.lastCapture)
              ? ` ${t("memory.lastNoticed", { count: noticedCount(status.lastCapture), plural: noticedCount(status.lastCapture) === 1 ? "" : "s", when: relativeTime(status.lastCapture.at) })}`
              : ""}
          </span>
        </div>
      )}
    </div>
  );
}

export function MemoryGauge({ index }: { index: MemoryCapacity }) {
  const status = capacityStatus(index);
  const fill = status.level === "over" ? "bg-danger" : status.level === "near" ? "bg-warning" : "bg-accent";
  return (
    <div className={cn("rounded-xl p-4", status.level === "over" ? "border border-danger/30 bg-danger/10" : "bg-card")}>
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="font-medium text-ink">{t("memory.gaugeTitle")}</span>
        <span className={cn("text-[12px]", status.level === "over" ? "text-danger" : "text-ink-secondary")}>
          {t("memory.gaugeStats", { lines: index.lines, maxLines: index.maxLines, bytes: formatBytes(index.bytes), maxBytes: formatBytes(index.maxBytes) })}
        </span>
      </div>
      <GaugeBar label={t("memory.lines")} share={status.lineShare} fill={fill} />
      <GaugeBar label={t("memory.size")} share={status.byteShare} fill={fill} />
      <p className={cn("mt-2 text-[12.5px] leading-relaxed", status.level === "over" ? "text-danger" : "text-ink-secondary")}>
        {status.warning ?? status.sentence}
      </p>
      {status.warning && <p className="mt-1 text-[12px] text-ink-secondary">{status.sentence}</p>}
    </div>
  );
}

function GaugeBar({ label, share, fill }: { label: string; share: number; fill: string }) {
  const width = `${Math.min(100, Math.round(share * 100))}%`;
  return (
    <div className="mt-2 flex items-center gap-2 text-[11.5px] text-ink-secondary">
      <span className="w-10 shrink-0">{label}</span>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-inset"
        role="meter"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.round(share * 100))}
      >
        <div className={cn("h-full rounded-full", fill)} style={{ width }} />
      </div>
    </div>
  );
}

export function ConflictNotice({
  botName,
  busy,
  onReload,
  onOverwrite,
}: {
  botName: string;
  busy: boolean;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  return (
    <div className="mt-2 rounded-lg border border-warning/25 bg-warning/10 p-3 text-[12.5px] leading-relaxed text-ink">
      <div className="font-medium">{t("memory.conflictTitle", { botName })}</div>
      <div className="mt-0.5 text-ink-secondary">
        {t("memory.conflictBody", { botName })}
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" className={buttonCls} disabled={busy} onClick={onReload}>
          {t("memory.reload")}
        </button>
        <button type="button" className={buttonCls} disabled={busy} onClick={onOverwrite}>
          {t("memory.overwriteWithMine")}
        </button>
      </div>
    </div>
  );
}

export function MemoryFileRows({
  title,
  hint,
  files,
  selected,
  onOpen,
  onDelete,
}: {
  title: string;
  hint: string;
  files: MemoryFileInfo[];
  selected?: string;
  onOpen: (file: MemoryFileInfo) => void;
  onDelete: (file: MemoryFileInfo) => void;
}) {
  return (
    <div>
      <div className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">{title}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">{hint}</div>
      {files.length === 0 ? (
        <div className="mt-2 text-[12.5px] text-ink-secondary">{t("memory.noneYet")}</div>
      ) : (
        <div className="mt-2 overflow-hidden rounded-lg border border-hairline/40">
          {files.map((file) => (
            <div
              key={file.path}
              className={cn(
                "flex items-center gap-2 border-b border-hairline/40 px-3 py-2 last:border-b-0",
                selected === file.path ? "bg-control/60" : "hover:bg-control/40",
              )}
            >
              <button type="button" onClick={() => onOpen(file)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <FileText size={14} className="shrink-0 text-ink-secondary" />
                <span className="truncate font-mono text-[12.5px] text-ink">{file.name}</span>
                <span className="shrink-0 text-[11.5px] text-ink-secondary">
                  {formatBytes(file.bytes)} · {relativeTime(file.modifiedAt)}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(file)}
                aria-label={`Delete ${file.name}`}
                title={t("memory.delete")}
                className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MemoryJournalList({
  rows,
  botName,
  reverting,
  onRevert,
  now = Date.now(),
}: {
  rows: MemoryJournalRow[] | null;
  botName: string;
  reverting: string | null;
  onRevert: (row: MemoryJournalRow) => void;
  now?: number;
}) {
  if (!rows) return <div className="text-[13px] text-ink-secondary">{t("memory.loading")}</div>;
  if (rows.length === 0) return <div className="text-[13px] text-ink-secondary">{t("memory.noChanges")}</div>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => {
        const source = journalSource(row);
        return (
          <div key={row.id} className="rounded-lg bg-inset px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink">
                <span>{journalSummary(row, botName)}</span>
                {" · "}
                <span className="text-ink-secondary">{relativeTime(row.at, now)}</span>
                {source && (
                  <>
                    {" · "}
                    <span className="text-ink-secondary">{source}</span>
                  </>
                )}
              </div>
              {row.canRevert ? (
                <button
                  type="button"
                  disabled={reverting !== null}
                  onClick={() => onRevert(row)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-accent-text hover:bg-accent/10 disabled:opacity-50"
                >
                  <RotateCcw size={12} />
                  {reverting === row.id ? t("memory.undoing") : t("memory.undo")}
                </button>
              ) : (
                <span className="shrink-0 text-[11.5px] text-ink-secondary" title={row.revertUnavailableReason}>
                  {t("memory.cantUndo")}
                </span>
              )}
            </div>
            {row.diff && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[12px] text-ink-secondary">
                  {t("memory.showWhatChanged", { added: row.added, removed: row.removed })}
                </summary>
                <pre className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md bg-card p-2 font-mono text-[11.5px] leading-relaxed text-ink">
                  {row.diff}
                </pre>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
