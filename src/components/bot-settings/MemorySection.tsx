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
  formatBytes,
  localizedRelativeTime,
  journalSource,
  journalSourceKey,
  fileLabel,
  openMemoryLocation,
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
import { activeLocale, t } from "@/lib/i18n";
import { roomMemoryCaptureEnabled } from "@/lib/feature-flags";
import { api, ApiError, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { Switch } from "../SettingsPrimitives";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { inputCls } from "./field";

const buttonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50";
const quietButtonCls = "rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";

interface Editing {
  path: string;
  text: string;
  hash: string;
  dirty: boolean;
  readOnly: boolean;
}

interface Conflict {
  path: string;
  current: string;
  currentHash: string;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function localizedTidySummary(report: Parameters<typeof tidySummary>[0]): string {
  const parts: string[] = [];
  const add = (count: number | undefined, one: "memory.upkeep.summary.archived.one" | "memory.upkeep.summary.merged.one" | "memory.upkeep.summary.crossed.one" | "memory.upkeep.summary.filed.one", many: "memory.upkeep.summary.archived.many" | "memory.upkeep.summary.merged.many" | "memory.upkeep.summary.crossed.many" | "memory.upkeep.summary.filed.many") => {
    if (count) parts.push(t(count === 1 ? one : many, { count }));
  };
  add(report.expired, "memory.upkeep.summary.archived.one", "memory.upkeep.summary.archived.many");
  add(report.duplicates, "memory.upkeep.summary.merged.one", "memory.upkeep.summary.merged.many");
  add(report.superseded, "memory.upkeep.summary.crossed.one", "memory.upkeep.summary.crossed.many");
  add(report.organized, "memory.upkeep.summary.filed.one", "memory.upkeep.summary.filed.many");
  const summary = parts.length ? parts.join(", ") : t("memory.upkeep.summary.none");
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

function localizedJournalSummary(row: MemoryJournalRow, botName: string): string {
  const who = row.actor === "bot" ? botName : row.actor === "import" ? t("memory.journal.actor.import") : row.actor === "upkeep" ? t("memory.journal.actor.upkeep") : t("memory.journal.actor.you");
  const file = fileLabel(row.path);
  const topic = row.path === MEMORY_INDEX ? file : row.path.startsWith("memory/log/") ? t("memory.journal.log", { file }) : t("memory.journal.topic", { file });
  const lines = (count: number) => t(count === 1 ? "memory.journal.line.one" : "memory.journal.line.many", { count });
  if (row.kind === "created") return t("memory.journal.created", { who, topic, detail: row.added ? t("memory.journal.withLines", { lines: lines(row.added) }) : "" });
  if (row.kind === "deleted") return t("memory.journal.deleted", { who, topic });
  if (row.added && !row.removed) return t("memory.journal.added", { who, lines: lines(row.added), topic });
  if (row.removed && !row.added) return t("memory.journal.removed", { who, lines: lines(row.removed), topic });
  return t("memory.journal.rewrote", { who, lines: lines(Math.max(row.added, row.removed)), topic });
}

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
  const [lendingReview, setLendingReview] = useState<LendingReview | null>(null);
  const [lendingReviewStale, setLendingReviewStale] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const { state, dispatch } = useStore();
  const learnFromRooms = roomMemoryCaptureEnabled(state.config);
  const [roomsSaving, setRoomsSaving] = useState(false);
  const [roomsError, setRoomsError] = useState("");

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
      setNotice(t("memory.restored", { path: row.path }));
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

  const toggleRooms = async () => {
    if (roomsSaving) return;
    setRoomsSaving(true);
    setRoomsError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { roomMemoryCapture: !learnFromRooms } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setRoomsError(cause instanceof Error ? cause.message : t("memory.learnFromRooms.error"));
    } finally {
      setRoomsSaving(false);
    }
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
      setNotice(`${localizedTidySummary(report)}.${report.note ? ` ${report.note}` : ""}`);
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
          {t("memory.enable")}
        </label>
        <p className="mt-1 text-[13px] text-ink-secondary">
          {t("memory.enableHelp")}
          {bot.busy ? ` ${t("memory.busyHelp")}` : ""}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
          {t("memory.notesHelp")}
        </p>
        {overview && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-secondary" title={overview.workspacePath}>
              {shortPath(overview.workspacePath, home)}
            </span>
            <button type="button" className={buttonCls} onClick={() => void openLocation("obsidian")}>
              {t("memory.openObsidian")}
            </button>
            <button type="button" className={cn(buttonCls, "inline-flex items-center gap-1.5")} onClick={() => void openLocation("folder")}>
              <FolderOpen size={14} />
              {t("memory.showFileManager")}
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
        rooms={{ enabled: learnFromRooms, saving: roomsSaving, error: roomsError, onToggle: () => void toggleRooms() }}
      />}

      {editing && (
        <div className="rounded-xl bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[13px] text-ink">{editing.path}</span>
            {editing.path !== MEMORY_INDEX && (
              <button type="button" className={quietButtonCls} onClick={() => void open(MEMORY_INDEX)}>
                {t("memory.backToIndex")}
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
            className={cn(inputCls, "mt-2 min-h-[200px] resize-y font-mono text-[13px] leading-relaxed")}
            value={editing.text}
            readOnly={editing.readOnly}
            placeholder={
              editing.path === MEMORY_INDEX
                ? t("memory.indexPlaceholder")
                : t("memory.notePlaceholder")
            }
            aria-label={editing.path === MEMORY_INDEX ? t("memory.botMemory") : t("memory.fileLabel", { path: editing.path })}
            onChange={(e) => setEditing({ ...editing, text: e.target.value, dirty: true })}
          />
          {editing.readOnly ? (
            <p className="mt-2 text-[12px] text-ink-secondary">{t("memory.logsReadOnly")}</p>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <button type="button" onClick={() => void save(editing.hash)} disabled={saving || !editing.dirty} className={buttonCls}>
                {saving ? t("memory.saving") : t("memory.save")}
              </button>
              {editing.dirty && (
                <button type="button" className={quietButtonCls} disabled={saving} onClick={() => void open(editing.path)}>
                  {t("memory.discard")}
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
              placeholder={t("memory.newTopicPlaceholder")}
              aria-label={t("memory.newTopicLabel")}
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
          {t("memory.changesHelp")}
        </p>
        <div className="mt-3">
          <MemoryJournalList rows={journal} botName={bot.name} reverting={reverting} onRevert={(row) => void revert(row)} />
        </div>
      </div>

      {notice && <div className="text-[13px] text-ink-secondary">{notice}</div>}
      {error && <div className="text-[13px] text-danger">{error}</div>}
    </div>
  );
}

export function topicTemplate(fileName: string): string {
  const title = fileName.replace(/\.md$/, "");
  return `---\ntitle: ${title}\ndescription: \naliases: []\n---\n\n`;
}


export function MemoryUpkeepCard({
  enabled,
  status,
  tidying,
  onToggle,
  onTidy,
  rooms,
}: {
  enabled: boolean;
  status: UpkeepStatus | null;
  tidying: boolean;
  onToggle: () => void;
  onTidy: () => void;
  rooms?: { enabled: boolean; saving: boolean; error: string; onToggle: () => void };
}) {
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-medium text-ink">{t("memory.upkeep.title")}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("memory.upkeep.help")}</p>
        </div>
        <Switch checked={enabled} aria-label={t("memory.upkeep.title")} onClick={onToggle} />
      </div>
      {enabled && rooms && (
        <div className="mt-3 flex items-start justify-between gap-3 border-t border-hairline/40 pt-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink">{t("memory.learnFromRooms.title")}</div>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">{t("memory.learnFromRooms.subtitle")}</p>
            {status && !status.modelSteps && (
              <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("memory.learnFromRooms.noModelSteps")}</p>
            )}
            {rooms.error && <p role="alert" className="mt-1 text-[13px] text-danger">{rooms.error}</p>}
          </div>
          <Switch
            checked={rooms.enabled}
            aria-label={t("memory.learnFromRooms.title")}
            disabled={rooms.saving}
            onClick={rooms.onToggle}
            className="disabled:cursor-wait disabled:opacity-50"
          />
        </div>
      )}
      {enabled && status && !status.modelSteps && (
        <p className="mt-2 text-[13px] text-ink-secondary">{t("memory.upkeep.noModelSteps")}</p>
      )}
      {enabled && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className={buttonCls} disabled={tidying} onClick={onTidy}>
            {tidying ? t("memory.upkeep.tidying") : t("memory.upkeep.tidyNow")}
          </button>
          <span className="text-[13px] text-ink-secondary">
            {status?.lastTidy ? t("memory.upkeep.lastTidy", { time: localizedRelativeTime(status.lastTidy.at, activeLocale()), summary: localizedTidySummary(status.lastTidy).toLowerCase() }) : t("memory.upkeep.notTidied")}
            {status?.lastCapture && noticedCount(status.lastCapture) ? ` ${t(noticedCount(status.lastCapture) === 1 ? "memory.upkeep.lastNoticed.one" : "memory.upkeep.lastNoticed.many", { count: noticedCount(status.lastCapture), time: localizedRelativeTime(status.lastCapture.at, activeLocale()) })}` : ""}
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
        <span className="font-medium text-ink">{t("memory.capacity.title")}</span>
        <span className={cn("text-[12px]", status.level === "over" ? "text-danger" : "text-ink-secondary")}>
          {index.lines} / {index.maxLines} lines · {formatBytes(index.bytes)} / {formatBytes(index.maxBytes)}
        </span>
      </div>
      <GaugeBar label={t("memory.capacity.lines")} share={status.lineShare} fill={fill} />
      <GaugeBar label={t("memory.capacity.size")} share={status.byteShare} fill={fill} />
      <p className={cn("mt-2 text-[13px] leading-relaxed", status.level === "over" ? "text-danger" : "text-ink-secondary")}>
          {status.warning ?? t("memory.capacity.sentence", { lines: index.lines, maxLines: index.maxLines, bytes: formatBytes(index.bytes), maxBytes: formatBytes(index.maxBytes), maxLoaded: index.maxLines })}
      </p>
      {status.warning && <p className="mt-1 text-[12px] text-ink-secondary">{t("memory.capacity.sentence", { lines: index.lines, maxLines: index.maxLines, bytes: formatBytes(index.bytes), maxBytes: formatBytes(index.maxBytes), maxLoaded: index.maxLines })}</p>}
    </div>
  );
}

function GaugeBar({ label, share, fill }: { label: string; share: number; fill: string }) {
  const width = `${Math.min(100, Math.round(share * 100))}%`;
  return (
    <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-secondary">
      <span className="w-10 shrink-0">{label}</span>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-inset"
        role="meter"
        aria-label={t("memory.capacity.used", { label })}
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
    <div className="mt-2 rounded-lg border border-warning/25 bg-warning/10 p-3 text-[13px] leading-relaxed text-ink">
      <div className="font-medium">{t("memory.conflict.title", { name: botName })}</div>
      <div className="mt-0.5 text-ink-secondary">
        {t("memory.conflict.help", { name: botName })}
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" className={buttonCls} disabled={busy} onClick={onReload}>
          {t("memory.reload")}
        </button>
        <button type="button" className={buttonCls} disabled={busy} onClick={onOverwrite}>
          {t("memory.overwrite")}
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
        <div className="mt-2 text-[13px] text-ink-secondary">{t("memory.noneYet")}</div>
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
                <span className="truncate font-mono text-[13px] text-ink">{file.name}</span>
                <span className="shrink-0 text-[12px] text-ink-secondary">
                  {formatBytes(file.bytes)} · {localizedRelativeTime(file.modifiedAt, activeLocale())}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(file)}
                aria-label={t("memory.deleteFile", { name: file.name })}
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
        const sourceKey = journalSourceKey(row);
        return (
          <div key={row.id} className="rounded-lg bg-inset px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink">
                <span>{localizedJournalSummary(row, botName)}</span>
                {" · "}
                <span className="text-ink-secondary">{localizedRelativeTime(row.at, activeLocale(), now)}</span>
                {source && (
                  <>
                    {" · "}
                    <span className="text-ink-secondary">{sourceKey ? t(sourceKey, row.threadTitle ? { title: row.threadTitle } : undefined) : source}</span>
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
                <span className="shrink-0 text-[12px] text-ink-secondary" title={row.revertUnavailableReason}>
                  {t("memory.cantUndo")}
                </span>
              )}
            </div>
            {row.diff && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[12px] text-ink-secondary">
                  +{row.added} −{row.removed} · {t("memory.showChanged")}
                </summary>
                <pre className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md bg-card p-2 font-mono text-[12px] leading-relaxed text-ink">
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
