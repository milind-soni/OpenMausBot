import { InputRule, markInputRule, nodeInputRule, wrappingInputRule, Node, Extension } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import { Selection } from "@tiptap/pm/state";
import { TableKit } from "@tiptap/extension-table";
import "katex/dist/katex.min.css";

const draftImage = Image.extend({
  parseHTML() {
    return [{
      tag: "span[data-draft-image]",
      getAttrs: (element) => ({
        src: element.getAttribute("data-draft-image"),
        alt: element.getAttribute("data-alt"),
        title: element.getAttribute("data-title"),
      }),
    }];
  },
  renderHTML({ node }) {
    const { src, alt, title } = node.attrs;
    // Keep image references editable without loading remote resources from unsent drafts.
    return ["span", { "data-draft-image": src, "data-alt": alt, "data-title": title }, alt || src || ""];
  },
}).configure({ inline: true });

const footnoteRef = Node.create({
  name: "footnoteRef",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({ label: { default: "" } }),
  parseHTML: () => [{ tag: "sup[data-footnote-ref]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["sup", { ...HTMLAttributes, "data-footnote-ref": "" }, node.attrs.label],
  markdownTokenizer: {
    name: "footnoteRef",
    level: "inline",
    start: (source) => source.indexOf("[^"),
    tokenize: (source) => {
      const match = /^\[\^([^\]\s]+)\]/.exec(source);
      return match ? { type: "footnoteRef", raw: match[0], label: match[1] } : undefined;
    },
  },
  parseMarkdown: (token, helpers) => helpers.createNode("footnoteRef", { label: token.label }),
  renderMarkdown: (node) => `[^${node.attrs?.label}]`,
  addInputRules() {
    return [nodeInputRule({
      find: /(?<=\S[ \t]|[^\s])(\[\^([^\]\s]+)\])$/,
      type: this.type,
      getAttributes: (match) => ({ label: match[2] }),
    })];
  },
});

const footnoteDefinition = Node.create({
  name: "footnoteDefinition",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({ label: { default: "" } }),
  parseHTML: () => [{ tag: "aside[data-footnote-definition]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["aside", { ...HTMLAttributes, "data-footnote-definition": node.attrs.label }, 0],
  markdownTokenizer: {
    name: "footnoteDefinition",
    level: "block",
    start: (source) => source.search(/(?:^|\n) {0,3}\[\^/),
    tokenize: (source, _tokens, lexer) => {
      const match = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?:\n(?= {4}|\t)| {4}[^\n]*|\t[^\n]*))*)/.exec(source);
      if (!match) return undefined;
      return {
        type: "footnoteDefinition",
        raw: match[0],
        label: match[1],
        tokens: lexer.blockTokens(match[2]!.replace(/\n(?: {4}|\t)/g, "\n")),
      };
    },
  },
  parseMarkdown: (token, helpers) => {
    const content = helpers.parseBlockChildren?.(token.tokens ?? []) ?? helpers.parseChildren(token.tokens ?? []);
    return helpers.createNode("footnoteDefinition", { label: token.label }, content.length ? content : [helpers.createNode("paragraph")]);
  },
  addInputRules() {
    return [wrappingInputRule({
      find: /^\[\^([^\]\s]+)\]:\s$/,
      type: this.type,
      getAttributes: (match) => ({ label: match[1] }),
    })];
  },
  renderMarkdown: (node, helpers) => {
    const body = helpers.renderChildren(node.content ?? [], "\n\n");
    return `[^${node.attrs?.label}]: ${body.replace(/\n(?=.)/g, "\n    ")}`;
  },
});

const inlineAfterBreak = Extension.create({
  name: "composerInlineAfterBreak",
  addInputRules() {
    const { bold, italic, strike } = this.editor.schema.marks;
    // Tiptap 3.35's document check rejects rules that consume the newline represented by a hard-break node.
    return [
      markInputRule({ find: /(?<=\n|[\p{L}\p{N}])\*\*([^*\n]+)\*\*$/u, type: bold! }),
      markInputRule({ find: /(?<=\n)__(?!_)([^_\n]+)__$/, type: bold! }),
      markInputRule({ find: /(?<=\n)\*([^*\n]+)\*$/, type: italic! }),
      markInputRule({ find: /(?<=\n)_([^_\n]+)_$/, type: italic! }),
      markInputRule({ find: /(?<=\n)~~([^~\n]+)~~$/, type: strike! }),
    ];
  },
});

const markdownTyping = Extension.create({
  name: "composerMarkdownTyping",
  priority: 110,
  addInputRules() {
    const editor = this.editor;
    return [
      new InputRule({
        find: /^\[([ xX])\][ \t]$/,
        handler: ({ state, range, match, chain }) => {
          const { $from } = state.selection;
          if ($from.depth < 3 || $from.node(-2).type.name !== "bulletList") return null;
          chain().deleteRange(range).liftListItem("listItem").toggleTaskList()
            .updateAttributes("taskItem", { checked: match[1]?.toLowerCase() === "x" }).run();
        },
      }),
      new InputRule({
        find: /(?<![!\\])\[[^\]\n]+\]\([^\s()<>]+\)$|(?<![\\*])\*\*\*[^*\n]+\*\*\*$|(?<![\\_])___[^_\n]+___$/,
        handler: ({ range, match, state }) => {
          const parsed = editor.markdown!.parse(match[0]).content?.[0];
          if (parsed?.type !== "paragraph" || !parsed.content?.some(node => node.marks?.length)) return null;
          state.tr.replaceWith(range.from, range.to, state.schema.nodeFromJSON(parsed).content);
        },
      }),
      new InputRule({
        find: /(?:^|(?<=\n))(?:\$\$[^$\n]+\$\$|[ \t]*\|[ :|-]+\|)$/,
        handler: ({ state, match }) => {
          const { tr, schema, selection: { $from } } = state;
          if ($from.depth !== 1) return null;
          const isMath = match[0].startsWith("$$");
          const index = $from.index(0);
          const current = $from.parent;
          const ownLine = current.textBetween(0, current.content.size, "\n", "\n") === match[0];
          if (isMath && !ownLine) return null;
          const previous = ownLine && !isMath && index > 0 ? tr.doc.child(index - 1) : null;
          if (!isMath && ownLine && previous?.type.name !== "paragraph") return null;
          const start = $from.before() - (previous?.nodeSize ?? 0);
          const source = editor.markdown!.serialize({
            type: "doc",
            content: (previous ? [previous, current] : [current]).map(node => node.toJSON()),
          }).replace(/\n\n(?=[ \t]*\|[ :|-]+\|$)/, "\n");
          const parsed = editor.markdown!.parse(source).content?.[0];
          if (parsed?.type !== (isMath ? "blockMath" : "table")) return null;
          const node = schema.nodeFromJSON(parsed);
          tr.replaceWith(start, $from.after(), isMath ? [node, schema.nodes.paragraph!.create()] : node);
          tr.setSelection(Selection.near(tr.doc.resolve(isMath ? start + node.nodeSize + 1 : start + 1)));
        },
      }),
    ];
  },
});

const inlineMath = InlineMath.extend({
  addInputRules() {
    return [nodeInputRule({
      find: /(?<![\\$])(\$(?![\s$])([^$\n]+?)(?<!\s)\$)$/,
      type: this.type,
      getAttributes: (match) => ({ latex: match[2] }),
    })];
  },
});

const katexOptions = { throwOnError: false, trust: false };

export const composerMarkdownExtensions = [
  draftImage,
  TableKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  BlockMath.configure({ katexOptions }),
  inlineMath.configure({ katexOptions }),
  footnoteRef,
  footnoteDefinition,
  inlineAfterBreak,
  markdownTyping,
];
