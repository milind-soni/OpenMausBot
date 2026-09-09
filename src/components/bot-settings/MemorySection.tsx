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
  topicFileName,
  type MemoryCapacity,
  type MemoryFileInfo,
  type MemoryJournalRow,
  type MemoryOverview,
} from "@/lib/memory";
import { shortPath } from "@/lib/short-path";
import type { Bot } from "@/state/store";
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

export function MemorySection({ bot, active = true }: { bot: Bot; active?: boolean }) {
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

  const refresh = async (openPath?: string) => {
    const [nextOverview, nextJournal] = await Promise.all([fetchMemoryOverview(bot.id), fetchMemoryJournal(bot.id)]);
    setOverview(nextOverview);
    setJournal(nextJournal);
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
    if (!window.confirm(`Delete ${file.name}? The journal below can bring it back.`)) return;
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
      setError("Give the topic a name — letters, numbers, spaces, dots or dashes.");
      return;
    }
    setNewTopic("");
    await open(`memory/${name}`);
    setEditing((current) => (current ? { ...current, dirty: true, text: current.text || `# ${name.replace(/\.md$/, "")}\n\n` } : current));
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
      setNotice(`Put ${row.path} back the way it was.`);
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

  const home = capabilities.host.homeDir;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Memory</div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
          Notes this bot keeps between tasks. They are plain markdown files in a folder on this computer — open them in any
          editor, or in Obsidian.
        </p>
        {overview && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-secondary" title={overview.workspacePath}>
              {shortPath(overview.workspacePath, home)}
            </span>
            <button type="button" className={buttonCls} onClick={() => void openLocation("obsidian")}>
              Open in Obsidian
            </button>
            <button type="button" className={cn(buttonCls, "inline-flex items-center gap-1.5")} onClick={() => void openLocation("folder")}>
              <FolderOpen size={14} />
              {fileManagerLabel(capabilities.host.platform)}
            </button>
          </div>
        )}
      </div>

      {overview && <MemoryGauge index={overview.index} />}

      {editing && (
        <div className="rounded-xl bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[12.5px] text-ink">{editing.path}</span>
            {editing.path !== MEMORY_INDEX && (
              <button type="button" className={quietButtonCls} onClick={() => void open(MEMORY_INDEX)}>
                Back to MEMORY.md
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
            placeholder={
              editing.path === MEMORY_INDEX
                ? "Nothing remembered yet. The bot writes durable notes here — or add your own."
                : "Write the note here."
            }
            aria-label={editing.path === MEMORY_INDEX ? "Bot memory" : `Memory file ${editing.path}`}
            onChange={(e) => setEditing({ ...editing, text: e.target.value, dirty: true })}
          />
          {editing.readOnly ? (
            <p className="mt-2 text-[12px] text-ink-secondary">Daily logs are the bot's own record of what it did; they are not loaded into conversations and are read-only here.</p>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <button type="button" onClick={() => void save(editing.hash)} disabled={saving || !editing.dirty} className={buttonCls}>
                {saving ? "Saving…" : "Save"}
              </button>
              {editing.dirty && (
                <button type="button" className={quietButtonCls} disabled={saving} onClick={() => void open(editing.path)}>
                  Discard changes
                </button>
              )}
            </div>
          )}
          {savedDraft !== null && (
            <div className="mt-3">
              <div className="mb-1 text-[12px] text-ink-secondary">Your unsaved draft, kept so nothing is lost:</div>
              <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink">
                {savedDraft}
              </pre>
              <button type="button" className={cn(quietButtonCls, "mt-1")} onClick={() => setSavedDraft(null)}>
                Dismiss draft
              </button>
            </div>
          )}
        </div>
      )}

      {overview && (
        <div className="rounded-xl bg-card p-4">
          <MemoryFileRows
            title="Topic files"
            hint="Longer notes the bot reads on demand. Click one to edit it."
            files={overview.topics}
            selected={editing?.path}
            onOpen={(file) => void open(file.path)}
            onDelete={(file) => void remove(file)}
          />
          <div className="mt-3 flex items-center gap-2">
            <input
              className={cn(inputCls, "py-1.5 text-[13px]")}
              value={newTopic}
              placeholder="New topic name, e.g. clients"
              aria-label="New topic name"
              onChange={(e) => setNewTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createTopic();
              }}
            />
            <button type="button" className={buttonCls} disabled={!newTopic.trim()} onClick={() => void createTopic()}>
              New topic
            </button>
          </div>
          {overview.logs.length > 0 && (
            <div className="mt-4">
              <MemoryFileRows
                title="Daily logs"
                hint="What the bot did each day, in its own words. Not loaded into conversations."
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
        <div className="text-[15px] font-medium text-ink">Changes</div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
          Every change to these files, whoever made it. Undo puts a file back the way it was before that change.
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

// ── presentational pieces (tested through renderToStaticMarkup) ─────────

export function MemoryGauge({ index }: { index: MemoryCapacity }) {
  const status = capacityStatus(index);
  const fill = status.level === "over" ? "bg-danger" : status.level === "near" ? "bg-warning" : "bg-accent";
  return (
    <div className={cn("rounded-xl p-4", status.level === "over" ? "border border-danger/30 bg-danger/10" : "bg-card")}>
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="font-medium text-ink">How much of MEMORY.md loads</span>
        <span className={cn("text-[12px]", status.level === "over" ? "text-danger" : "text-ink-secondary")}>
          {index.lines} / {index.maxLines} lines · {formatBytes(index.bytes)} / {formatBytes(index.maxBytes)}
        </span>
      </div>
      <GaugeBar label="Lines" share={status.lineShare} fill={fill} />
      <GaugeBar label="Size" share={status.byteShare} fill={fill} />
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
      <div className="font-medium">{botName} changed this file while you were editing.</div>
      <div className="mt-0.5 text-ink-secondary">
        Nothing has been saved. Reload to see {botName}'s version (your draft is kept below), or overwrite it with yours.
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" className={buttonCls} disabled={busy} onClick={onReload}>
          Reload
        </button>
        <button type="button" className={buttonCls} disabled={busy} onClick={onOverwrite}>
          Overwrite with mine
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
        <div className="mt-2 text-[12.5px] text-ink-secondary">None yet.</div>
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
                title="Delete"
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
  if (!rows) return <div className="text-[13px] text-ink-secondary">Loading…</div>;
  if (rows.length === 0) return <div className="text-[13px] text-ink-secondary">No changes recorded yet.</div>;
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
                  {reverting === row.id ? "Undoing…" : "Undo"}
                </button>
              ) : (
                <span className="shrink-0 text-[11.5px] text-ink-secondary" title={row.revertUnavailableReason}>
                  Can't undo
                </span>
              )}
            </div>
            {row.diff && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[12px] text-ink-secondary">
                  +{row.added} −{row.removed} · show what changed
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
