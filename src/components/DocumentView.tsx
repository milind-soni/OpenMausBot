// Obsidian-style document view for project Markdown and plain-text files.
// Markdown opens in a reading view (⌘E toggles the editor, as in Obsidian);
// text files open straight in the editor. Edits autosave, and a save is
// refused if the file changed on disk meanwhile, so an agent's write and
// the user's edit never silently overwrite each other.
import { createContext, forwardRef, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, BookOpen, Check, Loader2, Pencil } from "lucide-react";
import { CodeBlock } from "@/components/ChatMarkdown";
import { remarkObsidian, splitFrontmatter, toggleTaskLine } from "@/lib/obsidianMarkdown";
import { cn } from "@/lib/cn";

const AUTOSAVE_MS = 800;

/** Header slots supplied by the Quick preview panel, so the save status and
 * Read/Edit switch live in its file bar instead of a second toolbar. */
export const DocumentChromeContext = createContext<{ status: HTMLElement | null; controls: HTMLElement | null } | null>(null);

type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

const flat = (n: any): string =>
  typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : n?.props?.children ? flat(n.props.children) : "";

const ObsidianReading = memo(function ObsidianReading({ source, onToggleTask }: { source: string; onToggleTask: (line: number) => void }) {
  const { properties, body, lineOffset } = useMemo(() => splitFrontmatter(source), [source]);
  return (
    <div className="markdown-reading">
      {properties.length > 0 && (
        <div className="md-properties">
          <div className="md-properties-heading">Properties</div>
          {properties.map(([key, value]) => (
            <div key={key} className="md-property">
              <span className="md-property-key">{key}</span>
              <span className="md-property-value">{value}</span>
            </div>
          ))}
        </div>
      )}
      <Markdown
        remarkPlugins={[remarkGfm, remarkObsidian]}
        components={{
          pre({ children }: { children?: ReactNode }) {
            const child: any = Array.isArray(children) ? children[0] : children;
            const lang = /language-([\w-]+)/.exec(child?.props?.className ?? "")?.[1] ?? "";
            return <CodeBlock code={flat(child?.props?.children).replace(/\n$/, "")} lang={lang} streaming={false} />;
          },
          a({ href, children }: { href?: string; children?: ReactNode }) {
            return <a href={href} target="_blank" rel="noreferrer" className="external-link">{children}</a>;
          },
          img({ src, alt }: { src?: string; alt?: string }) {
            return <img src={src} alt={alt ?? ""} loading="lazy" />;
          },
          table({ children }: { children?: ReactNode }) {
            return <div className="md-table-wrap"><table>{children}</table></div>;
          },
          li({ node, className, children }: any) {
            if (!String(className ?? "").includes("task-list-item")) return <li className={className}>{children}</li>;
            const line = (node?.position?.start?.line ?? 0) + lineOffset;
            const [box, ...rest] = Array.isArray(children) ? children : [children];
            const checked = Boolean(box?.props?.checked);
            return (
              <li className={cn("task-list-item", checked && "is-checked")}>
                <input
                  type="checkbox"
                  className="task-list-item-checkbox"
                  checked={checked}
                  onChange={() => onToggleTask(line)}
                  aria-label={checked ? "Mark task as not done" : "Mark task as done"}
                />
                {rest}
              </li>
            );
          },
        }}
      >
        {body}
      </Markdown>
    </div>
  );
});

export interface DocumentViewProps {
  kind: "markdown" | "text";
  fileName: string;
  /** Latest content and modification time read from disk. */
  content: string;
  mtimeMs: number | null;
  onSave: (content: string, baseMtimeMs: number | null) => Promise<number>;
  /** Re-read the file from disk (used to resolve a conflict). */
  onReload: () => void;
}

export const DocumentView = forwardRef<HTMLDivElement, DocumentViewProps>(function DocumentView(
  { kind, fileName, content, mtimeMs, onSave, onReload },
  scrollRef,
) {
  const [mode, setMode] = useState<"read" | "edit">(kind === "text" ? "edit" : "read");
  const [draft, setDraft] = useState(content);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState("");
  const baseMtime = useRef(mtimeMs);
  const lastSaved = useRef(content);
  const savingText = useRef<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setMode(kind === "text" ? "edit" : "read"); }, [kind, fileName]);

  // Disk content changed (first load, our own save echoing back, or an external write).
  useEffect(() => {
    if (content === lastSaved.current && mtimeMs === baseMtime.current) return;
    if (content === savingText.current || (content === lastSaved.current && draftRef.current !== content)) {
      // Our own save echoing back from the file watcher: adopt it as the baseline, keep typing.
      lastSaved.current = content;
      baseMtime.current = mtimeMs;
      return;
    }
    if (draftRef.current !== lastSaved.current && content !== draftRef.current) {
      // Unsaved local edits and a different version on disk: let the user choose.
      setSaveState("conflict");
      return;
    }
    lastSaved.current = content;
    baseMtime.current = mtimeMs;
    setDraft(content);
    setSaveState("saved");
  }, [content, mtimeMs]);

  const save = useCallback(async (text: string, force = false) => {
    clearTimeout(timer.current);
    if (text === lastSaved.current && !force) return setSaveState("saved");
    setSaveState("saving");
    savingText.current = text;
    try {
      const mtime = await onSave(text, force ? null : baseMtime.current);
      lastSaved.current = text;
      baseMtime.current = mtime;
      setSaveError("");
      setSaveState(draftRef.current === text ? "saved" : "dirty");
    } catch (err) {
      const status = (err as { status?: number }).status;
      setSaveState(status === 409 ? "conflict" : "error");
      setSaveError(err instanceof Error ? err.message : "Couldn't save the file.");
    } finally {
      savingText.current = null;
    }
  }, [onSave]);

  const change = useCallback((text: string) => {
    setDraft(text);
    setSaveState(s => (s === "conflict" ? s : "dirty"));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setSaveState(s => {
        if (s !== "conflict") void save(draftRef.current);
        return s;
      });
    }, AUTOSAVE_MS);
  }, [save]);

  // Flush pending edits when the file or panel closes.
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (draftRef.current !== lastSaved.current) void onSave(draftRef.current, baseMtime.current).catch(() => {});
  }, [fileName, onSave]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (saveState !== "conflict") void save(draftRef.current);
    } else if (mod && e.key.toLowerCase() === "e" && kind === "markdown") {
      e.preventDefault();
      setMode(m => (m === "read" ? "edit" : "read"));
    }
  };

  useEffect(() => { if (mode === "edit") editorRef.current?.focus({ preventScroll: true }); }, [mode]);

  const toggleTask = useCallback((line: number) => {
    const next = toggleTaskLine(draftRef.current, line);
    if (next !== draftRef.current) { setDraft(next); void save(next); }
  }, [save]);

  const status = saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Edited" : saveState === "saved" ? "Saved" : saveState === "error" ? "Not saved" : "Changed on disk";
  const chrome = useContext(DocumentChromeContext);

  const statusLine = (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1" aria-live="polite">
      {saveState === "saving" ? <Loader2 className="h-3 w-3 animate-spin" /> : saveState === "saved" ? <Check className="h-3 w-3 text-success" /> : saveState === "dirty" ? <span className="h-1.5 w-1.5 rounded-full bg-ink-secondary" /> : <AlertTriangle className="h-3 w-3 text-warning" />}
      <span className="truncate">{status}</span>
    </span>
  );

  const segment = (active: boolean) => cn(
    "flex h-6 items-center justify-center gap-1 rounded-[5px] px-1.5 text-[11.5px] font-medium transition-colors",
    active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
  );
  const modeSwitch = kind === "markdown" ? (
    <div role="group" aria-label="Document mode" className="flex shrink-0 items-center gap-0.5 rounded-md border border-hairline/50 bg-inset p-0.5">
      <button type="button" onClick={() => setMode("read")} aria-pressed={mode === "read"} aria-label="Reading view" title="Reading view (⌘E)" className={segment(mode === "read")}>
        <BookOpen className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => setMode("edit")} aria-pressed={mode === "edit"} aria-label="Edit" title="Edit (⌘E)" className={segment(mode === "edit")}>
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </div>
  ) : null;

  return (
    <div className="flex h-full w-full flex-col bg-panel" onKeyDown={onKeyDown}>
      {chrome?.status ? createPortal(statusLine, chrome.status) : null}
      {chrome?.controls ? createPortal(modeSwitch, chrome.controls) : null}
      {!chrome?.status && (
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-hairline/30 px-3 text-[12px] text-ink-secondary">
          {statusLine}
          {modeSwitch}
        </div>
      )}
      {(saveState === "conflict" || saveState === "error") && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-ink">
          <span className="min-w-0 flex-1">
            {saveState === "conflict" ? "This file was changed on disk while you were editing." : saveError || "Couldn't save the file."}
          </span>
          {saveState === "conflict" ? (
            <>
              <button type="button" onClick={() => { lastSaved.current = content; baseMtime.current = mtimeMs; setDraft(content); setSaveState("saved"); onReload(); }}
                className="rounded border border-hairline/50 px-2 py-0.5 hover:bg-raised">Load disk version</button>
              <button type="button" onClick={() => void save(draftRef.current, true)}
                className="rounded border border-hairline/50 px-2 py-0.5 hover:bg-raised">Keep my version</button>
            </>
          ) : (
            <button type="button" onClick={() => void save(draftRef.current)} className="rounded border border-hairline/50 px-2 py-0.5 hover:bg-raised">Try again</button>
          )}
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto select-text">
        {mode === "read" && kind === "markdown" ? (
          <ObsidianReading source={draft} onToggleTask={toggleTask} />
        ) : (
          <textarea
            ref={editorRef}
            value={draft}
            onChange={e => change(e.target.value)}
            spellCheck={kind === "markdown"}
            aria-label={`Edit ${fileName}`}
            className={cn("markdown-source block min-h-full w-full resize-none bg-transparent outline-none", kind === "text" && "is-plain-text")}
            style={{ height: "auto" }}
            rows={Math.max(20, draft.split("\n").length + 4)}
          />
        )}
      </div>
    </div>
  );
});
