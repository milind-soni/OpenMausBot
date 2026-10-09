import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2, Play, X } from "lucide-react";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { t } from "@/lib/i18n";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import type { ColorScheme } from "@/lib/color-scheme";

export interface SqlEditorProps {
  /** Tables and columns the editor completes (data-format.ts sqlNamespace). */
  schema: SQLNamespace;
  /** The card whose SQL is being edited; null adds a new card. */
  editing: { cardId: string; title: string; sql: string } | null;
  /** A card of the person's is running: Esc cancels it. */
  running: boolean;
  theme: ColorScheme;
  onRun: (sql: string) => void;
  onCancel: () => void;
  onStopEditing: () => void;
}

type EditorModules = { cm: typeof import("codemirror"); sql: typeof import("@codemirror/lang-sql") };
/** One load per window: the chunk is shared by every editor after the first. */
let editorModules: Promise<EditorModules> | null = null;
export function loadEditor(): Promise<EditorModules> {
  editorModules ??= Promise.all([import("codemirror"), import("@codemirror/lang-sql")])
    .then(([cm, sql]) => ({ cm, sql }))
    // A failed chunk is not remembered: the next mount tries again.
    .catch((cause: unknown) => { editorModules = null; throw cause; });
  return editorModules;
}

/** Cmd/Ctrl+Enter runs, Esc cancels. The same handler serves the plain box
 * and the CodeMirror view, so the keys mean the same in both. */
function keyAction(event: { key: string; metaKey: boolean; ctrlKey: boolean }): "run" | "cancel" | null {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) return "run";
  if (event.key === "Escape") return "cancel";
  return null;
}

/** Inline SQL for the person's own cards. The text lives in a plain box
 * from the first paint, so typing never waits; CodeMirror (with schema
 * completion) takes over the same text when its chunk arrives. If that
 * chunk never loads, the plain box simply stays. */
export function SqlEditor({ schema, editing, running, theme, onRun, onCancel, onStopEditing }: SqlEditorProps) {
  const [text, setText] = useState(editing?.sql ?? "");
  const [modules, setModules] = useState<EditorModules | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<InstanceType<EditorModules["cm"]["EditorView"]> | null>(null);
  const callbacks = useRef({ onRun, onCancel, onStopEditing, editing, running });
  callbacks.current = { onRun, onCancel, onStopEditing, editing, running };

  const run = () => {
    const sql = textRef.current.trim();
    if (!sql) return;
    callbacks.current.onRun(sql);
    // A new card's SQL now lives on the card (Edit brings it back); an edit
    // stays in the box so the next run refines it.
    if (!callbacks.current.editing) replaceText("");
  };
  const cancel = () => {
    if (callbacks.current.running) callbacks.current.onCancel();
    else if (callbacks.current.editing) callbacks.current.onStopEditing();
  };
  const handleKey = (event: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault(): void }): boolean => {
    const action = keyAction(event);
    if (!action) return false;
    event.preventDefault();
    if (action === "run") run(); else cancel();
    return true;
  };
  const replaceText = (next: string) => {
    setText(next);
    textRef.current = next;
    const current = view.current;
    if (current && current.state.doc.toString() !== next) {
      current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: next } });
    }
  };

  // Edit on a card: its SQL replaces the box. Stopping keeps what is there.
  const editingId = editing?.cardId ?? null;
  const editingSql = editing?.sql ?? null;
  useEffect(() => { if (editingId !== null && editingSql !== null) replaceText(editingSql); }, [editingId, editingSql]);

  useEffect(() => {
    let alive = true;
    loadEditor().then((loaded) => { if (alive) setModules(loaded); }).catch(() => { /* the plain box stays */ });
    return () => { alive = false; };
  }, []);

  // Mount CodeMirror once its modules are here; rebuild when the schema or
  // skin changes (the editor's own setup is immutable, and that is rare).
  useEffect(() => {
    const element = host.current;
    if (!modules || !element) return;
    const { EditorView, basicSetup } = modules.cm;
    const editor = new EditorView({
      doc: textRef.current,
      parent: element,
      extensions: [
        // First in the list, so Cmd/Ctrl+Enter is ours before the default
        // keymap's "insert blank line"; completion's own Esc (higher
        // precedence) still closes its list first.
        EditorView.domEventHandlers({ keydown: (event) => handleKey(event) }),
        basicSetup,
        modules.sql.sql({ dialect: modules.sql.PostgreSQL, schema, upperCaseKeywords: true }),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          textRef.current = next;
          setText(next);
        }),
        EditorView.theme({
          "&": { backgroundColor: "transparent", color: "var(--color-ink)", fontSize: "12.5px", maxHeight: "40vh" },
          ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: "1.5", overflow: "auto" },
          ".cm-content": { caretColor: "var(--color-ink)", padding: "8px 0" },
          "&.cm-focused": { outline: "none" },
          ".cm-gutters": { backgroundColor: "transparent", color: "var(--color-ink-tertiary)", border: "none" },
          ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--color-ink) 5%, transparent)" },
          ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-ink)" },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--color-accent) 30%, transparent)" },
          ".cm-tooltip": { backgroundColor: "var(--color-menu)", color: "var(--color-ink)", border: "1px solid var(--color-hairline)", borderRadius: "8px" },
          ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--color-accent)", color: "var(--color-accent-ink)" },
        }, { dark: theme === "dark" }),
      ],
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [modules, schema, theme]);

  const keyLabel = isMacPlatform() ? "⌘↩" : "Ctrl+↩";
  return (
    <div className="border-t border-hairline/40 bg-card px-3 pb-3 pt-2" data-testid="sql-editor">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-ink-secondary">
        <span className="font-medium text-ink">{t("data.editor.label")}</span>
        {editing && (
          <span className="flex items-center gap-1 rounded-full bg-inset px-2 py-0.5 text-accent-text">
            {t("data.editor.editing", { title: editing.title })}
            <button type="button" onClick={onStopEditing} aria-label={t("data.editor.stopEditing")} title={t("data.editor.stopEditing")} className="rounded-full p-0.5 hover:bg-raised">
              <X size={11} />
            </button>
          </span>
        )}
        <span className="ml-auto">{t("data.editor.placeholder", { key: keyLabel })}</span>
      </div>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 rounded-xl border border-hairline/60 bg-inset focus-within:ring-1 focus-within:ring-accent">
          {modules ? (
            <div ref={host} className="min-h-[72px]" />
          ) : (
            <textarea value={text} onChange={(event) => { setText(event.target.value); textRef.current = event.target.value; }}
              onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => handleKey(event)}
              aria-label={t("data.editor.label")} placeholder={t("data.editor.placeholder", { key: keyLabel })} spellCheck={false} rows={3}
              className="block w-full resize-y bg-transparent px-3 py-2 font-mono text-[12.5px] leading-6 text-ink outline-none placeholder:text-ink-tertiary" />
          )}
        </div>
        <button type="button" onClick={run} disabled={!text.trim()} aria-label={t("data.editor.run")} title={`${t("data.editor.run")} (${keyLabel})`}
          className="flex h-9 items-center gap-1.5 rounded-xl bg-accent px-3 text-[12.5px] font-medium text-accent-ink disabled:opacity-40">
          {running ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          {t("data.editor.run")}
        </button>
      </div>
    </div>
  );
}
