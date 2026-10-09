import { useEffect, useRef } from "react";
import { EditorView, minimalSetup } from "codemirror";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { PostgreSQL, SQLDialect, sql as sqlLanguage } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { t } from "@/lib/i18n";
import { useColorScheme, type ColorScheme } from "@/lib/color-scheme";

// DuckDB uses PostgreSQL-like SQL plus these commonly used query clauses.
const duckdb = SQLDialect.define({ ...PostgreSQL.spec, keywords: `${PostgreSQL.spec.keywords} summarize qualify pivot unpivot exclude replace sample` });
const fromBot = Annotation.define<boolean>();
const appearance = (scheme: ColorScheme) => [
  syntaxHighlighting(HighlightStyle.define([
    { tag: tags.keyword, color: scheme === "dark" ? "#c4a7ff" : "#713ab0" },
    { tag: tags.string, color: scheme === "dark" ? "#a3d6a5" : "#256a35" },
    { tag: [tags.number, tags.bool, tags.null], color: scheme === "dark" ? "#e6bd7a" : "#8b5510" },
    { tag: tags.comment, color: "var(--color-ink-secondary)", fontStyle: "italic" },
    { tag: [tags.operator, tags.punctuation], color: "var(--color-ink-secondary)" },
  ])),
  EditorView.theme({
    "&": { height: "100%", backgroundColor: "transparent", color: "var(--color-ink)", fontSize: "12.5px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono, monospace)", lineHeight: "24px", overflow: "auto" },
    ".cm-content": { padding: "8px 0", caretColor: "var(--color-ink)" },
    ".cm-line": { padding: "0 12px" },
    ".cm-cursor": { borderLeftColor: "var(--color-ink)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--color-accent) 25%, transparent)" },
  }, { dark: scheme === "dark" }),
];

/** Local query echoes preserve the draft; a completed bot edit is authoritative. */
export function SqlEditor({ sql, externalRevision, readOnly, onChange }: { sql: string; externalRevision?: string; readOnly?: boolean; onChange: (sql: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const configuration = useRef(new Compartment());
  const callback = useRef(onChange);
  callback.current = onChange;
  const scheme = useColorScheme();
  const lastExternalRevision = useRef(externalRevision);
  useEffect(() => {
    const editor = new EditorView({
      doc: sql,
      parent: host.current!,
      extensions: [
        minimalSetup, sqlLanguage({ dialect: duckdb }), EditorView.lineWrapping,
        configuration.current.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(fromBot))) {
            callback.current(update.state.doc.toString());
          }
        }),
      ],
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, []);
  useEffect(() => {
    view.current?.dispatch({ effects: configuration.current.reconfigure([
      ...appearance(scheme), EditorState.readOnly.of(Boolean(readOnly)), EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ "aria-label": t("data.editor.label"), "aria-multiline": "true", spellcheck: "false" }),
    ]) });
  }, [scheme, readOnly]);
  useEffect(() => {
    if (externalRevision === undefined || externalRevision === lastExternalRevision.current) return;
    lastExternalRevision.current = externalRevision;
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== sql) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: sql }, annotations: fromBot.of(true) });
    }
  }, [externalRevision, sql]);
  return (
    <div ref={host} data-testid="sql-editor"
      className="min-h-0 w-full flex-1 overflow-hidden rounded-lg border border-hairline/50 bg-inset focus-within:ring-1 focus-within:ring-accent" />
  );
}
