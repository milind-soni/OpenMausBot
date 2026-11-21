import { Editor, Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { Marked, type marked } from "marked";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { imeComposing } from "@/lib/send-key";
import { mentionClassName, mentionRanges, type MentionPeer } from "@/lib/mentions";

import { normalizeMathDelimiters } from "./ChatMarkdown";
import { composerMarkdownExtensions } from "./composer-markdown";

const composerKeys = Extension.create({
  name: "composerKeys",
  priority: 110,
  addKeyboardShortcuts() {
    const editor = this.editor;
    const continueList = () => {
      const item = listItem(editor);
      if (!item) return false;
      return editor.chain().splitListItem(item).command(({ tr }) => {
        tr.removeStoredMark(editor.schema.marks.code!);
        return true;
      }).run() || editor.commands.liftListItem(item);
    };
    return {
      Enter: continueList,
      Backspace: () => {
        const { empty, $from } = editor.state.selection;
        const item = listItem(editor);
        return Boolean(item && empty && $from.parentOffset === 0 && editor.commands.liftListItem(item));
      },
      "Shift-Enter": continueList,
    };
  },
});

function listItem(editor: Editor) {
  return editor.isActive("taskItem") ? "taskItem" : editor.isActive("listItem") ? "listItem" : null;
}

function inList(editor: Editor) {
  return listItem(editor) !== null;
}

function draftMarkdown(text: string): string {
  if (/^(?:[-+*]|\d{1,9}[.)])$/.test(text)) return text.replace(/[.)*+-]$/, "\\$&");
  return /[$\\]/.test(text) ? normalizeMathDelimiters(text) : text;
}

function markdownOffset(editor: Editor, position: number, markdown: string) {
  // Measure with Tiptap's serializer so list markers, escaping and marks count in draft offsets.
  let marker = "\uE000\uE001";
  while (markdown.includes(marker)) marker = "\uE000" + marker;
  const doc = editor.state.tr.insertText(marker, position, position).doc;
  const marked = editor.markdown!.serialize(doc.toJSON());
  return Math.max(0, Math.min(markdown.length, marked.indexOf(marker)));
}

export function composerSelection(editor: Editor) {
  const { from, to } = editor.state.selection;
  const markdown = editor.getMarkdown();
  const start = markdownOffset(editor, from, markdown);
  return { start, end: from === to ? start : markdownOffset(editor, to, markdown) };
}

export function focusComposer(editor: Editor | null, offset?: number) {
  if (!editor?.isEditable) return;
  if (offset === undefined || offset >= editor.getMarkdown().length) {
    editor.commands.focus("end");
    return;
  }
  const markdown = editor.getMarkdown();
  let position = editor.state.selection.from;
  editor.state.doc.descendants((node, start) => {
    if (!node.isTextblock) return true;
    let low = start + 1;
    let high = low + node.content.size;
    if (markdownOffset(editor, low, markdown) > offset || markdownOffset(editor, high, markdown) < offset) return false;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (markdownOffset(editor, middle, markdown) < offset) low = middle + 1;
      else high = middle;
    }
    position = low;
    return false;
  });
  editor.commands.focus(position);
}

function updatePlaceholder(editor: Editor) {
  const { doc } = editor.state;
  const first = doc.firstChild;
  editor.view.dom.toggleAttribute("data-empty", doc.childCount === 1 && first?.type.name === "paragraph" && first.content.size === 0);
}

type Props = {
  editorRef: RefObject<Editor | null>;
  inputRef: RefObject<HTMLElement | null>;
  value: string;
  disabled: boolean;
  busy?: boolean;
  placeholder: string;
  label: string;
  smoothHeight?: boolean;
  wrapperClassName?: string;
  peers: readonly MentionPeer[];
  everyone: boolean;
  onOpenBot: (id: string) => void;
  onChange: (value: string) => void;
  onSelection: (caret: number, inList: boolean) => void;
  onPaste: (event: ClipboardEvent, editor: Editor) => void;
  onKeyDown: (event: KeyboardEvent, inList: boolean) => void;
};

export function ComposerEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const synced = useRef(props.value);
  latest.current = props;

  useLayoutEffect(() => {
    const { inputRef, editorRef } = latest.current;
    const mentions = Extension.create({
      name: "composerMentions",
      addProseMirrorPlugins() {
        return [new Plugin({
          props: {
            decorations: (state) => {
              const marks: Decoration[] = [];
              state.doc.descendants((node, pos) => {
                if (!node.isTextblock || node.type.spec.code) return;
                const text = node.textBetween(0, node.content.size, "\n", "\n");
                for (const range of mentionRanges(text, latest.current.peers, latest.current.everyone)) {
                  const start = pos + 1 + range.start;
                  const end = pos + 1 + range.end;
                  if (state.doc.rangeHasMark(start, end, state.schema.marks.code!)) continue;
                  marks.push(Decoration.inline(start, end, {
                    class: mentionClassName(range),
                    ...(range.color ? { style: `--mention-color: ${range.color}` } : {}),
                    ...(range.bot?.id ? { "data-mention-bot-id": range.bot.id } : {}),
                  }));
                }
              });
              return DecorationSet.create(state.doc, marks);
            },
          },
        })];
      },
    });
    const editor = new Editor({
      element: host.current!,
      extensions: [
        StarterKit.configure({
          trailingNode: false,
          code: { HTMLAttributes: { class: "ui-code-chip" } },
          link: { openOnClick: false, protocols: ["openmausbot"] },
        }),
        // Tiptap 3.35 registers tokenizers on the Marked instance.
        Markdown.configure({ marked: new Marked() as unknown as typeof marked, markedOptions: { breaks: true } }),
        composerKeys,
        mentions,
        ...composerMarkdownExtensions,
      ],
      content: draftMarkdown(latest.current.value),
      contentType: "markdown",
      editorProps: {
        clipboardTextParser: (text, context, plain) => {
          if (plain) {
            const { schema } = editor;
            const paragraphs = text.split(/\r?\n/).map(line =>
              schema.nodes.paragraph!.create(null, line ? schema.text(line, context.marks()) : undefined));
            return Slice.maxOpen(Fragment.fromArray(paragraphs));
          }
          const doc = editor.schema.nodeFromJSON(editor.markdown!.parse(draftMarkdown(text)));
          return Slice.maxOpen(doc.content, false);
        },
        attributes: { role: "textbox", "aria-multiline": "true", dir: "auto", class: "composer-editor" },
        handleDOMEvents: {
          keydown: (view, event) => {
            if (!view.editable) return false;
            if (view.composing || imeComposing(event)) return true;
            latest.current.onKeyDown(event, inList(editor));
            return event.defaultPrevented;
          },
          paste: (view, event) => {
            if (!view.editable) return false;
            latest.current.onPaste(event, editor);
            return event.defaultPrevented;
          },
          click: (view, event) => {
            if (!view.state.selection.empty || event.detail !== 1 || !(event.target instanceof Element)) return false;
            const id = event.target.closest<HTMLElement>("[data-mention-bot-id]")?.dataset.mentionBotId;
            if (id && (event.ctrlKey || event.metaKey)) latest.current.onOpenBot(id);
            return false;
          },
        },
      },
      onTransaction: ({ editor, transaction }) => {
        if (transaction.docChanged) updatePlaceholder(editor);
      },
      onUpdate: ({ editor }) => {
        const value = editor.getMarkdown();
        synced.current = value;
        const caret = markdownOffset(editor, editor.state.selection.from, value);
        latest.current.onChange(value);
        latest.current.onSelection(caret, inList(editor));
      },
      onSelectionUpdate: ({ editor, transaction }) => {
        if (!transaction.docChanged) latest.current.onSelection(composerSelection(editor).start, inList(editor));
      },
    });
    inputRef.current = editor.view.dom;
    editorRef.current = editor;
    editor.commands.setTextSelection(editor.state.doc.content.size);
    latest.current.onSelection(latest.current.value.length, inList(editor));
    return () => {
      editorRef.current = null;
      inputRef.current = null;
      editor.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const editor = props.editorRef.current!;
    if (synced.current !== props.value) {
      synced.current = props.value;
      editor.commands.setContent(draftMarkdown(props.value), { contentType: "markdown", emitUpdate: false });
      editor.commands.setTextSelection(editor.state.doc.content.size);
      props.onSelection(props.value.length, inList(editor));
    }
    if (editor.isEditable === props.disabled) editor.setEditable(!props.disabled, false);
    const input = editor.view.dom;
    input.setAttribute("aria-label", props.label);
    input.setAttribute("aria-disabled", String(props.disabled));
    input.setAttribute("aria-busy", String(Boolean(props.busy)));
    input.setAttribute("aria-placeholder", props.placeholder);
    input.dataset.placeholder = props.placeholder;
    updatePlaceholder(editor);
  });

  return <div ref={host} data-composer-editor="" aria-busy={props.busy || undefined} className={cn("relative min-w-0 flex-1 self-center", props.wrapperClassName, props.smoothHeight && "v2-composer-field")} />;
}
