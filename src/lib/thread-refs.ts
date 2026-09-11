// "#QA PR 245" in prose becomes a link to that thread. Bots are asked to
// write a thread's title as #Title when they mention one, and the person
// may type the same. Resolution mirrors @mention resolution for bots:
// word-start, longest known title first, case-insensitive — titles hold
// spaces, so the longest known title following the "#" wins. Nothing else
// is a link: "#123" issue numbers, "# Heading" markers (the parser never
// hands those here) and unknown titles all stay plain text.

/** A thread the person can see: any bot's task, or a room's. `activeAt`
 * orders threads that share a title (newest wins) after the current bot. */
export interface ThreadRefCandidate {
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  activeAt?: number;
}

export interface ResolvedThreadRef {
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  /** another visible thread shares this title; the tooltip names the bot */
  ambiguous: boolean;
}

/** One run of text, linked when `ref` is set. */
export interface ThreadRefSpan {
  text: string;
  ref?: ResolvedThreadRef;
}

interface TitleGroup {
  lower: string;
  candidates: ThreadRefCandidate[];
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
/** a "#" glued to one of these is not a word start: C#Title, &#39;, ##x */
const NOT_WORD_START = /[\p{L}\p{N}_#&]/u;

/** Only a title that is a real name can be linked: "123" would turn every
 * issue number into a thread link. */
function linkable(title: string): boolean {
  return title.length > 0 && !/^\d+$/.test(title);
}

/** Known titles, longest first, each with every thread that carries it in
 * the caller's (recency) order. */
function groupTitles(threads: ThreadRefCandidate[]): TitleGroup[] {
  const groups = new Map<string, TitleGroup>();
  const seen = new Set<string>();
  for (const thread of threads) {
    const title = thread.title.trim();
    const key = `${thread.botId}/${thread.threadId}`;
    if (!linkable(title) || seen.has(key)) continue;
    seen.add(key);
    const lower = title.toLowerCase();
    const group = groups.get(lower);
    if (group) group.candidates.push({ ...thread, title });
    else groups.set(lower, { lower, candidates: [{ ...thread, title }] });
  }
  return [...groups.values()].sort((a, b) => b.lower.length - a.lower.length);
}

/** Which of several same-titled threads a mention means: the current
 * bot's, else the most recently active, else the first — flagged so the
 * link can say which bot it landed on. */
function pick(candidates: ThreadRefCandidate[], currentBotId: string | undefined): ResolvedThreadRef {
  const resolved = (thread: ThreadRefCandidate, ambiguous: boolean): ResolvedThreadRef => ({
    botId: thread.botId, botName: thread.botName, threadId: thread.threadId, title: thread.title, ambiguous,
  });
  if (candidates.length === 1) return resolved(candidates[0], false);
  const own = candidates.filter((thread) => thread.botId === currentBotId);
  if (own.length === 1) return resolved(own[0], false);
  const pool = own.length > 1 ? own : candidates;
  const stamps = pool.map((thread) => thread.activeAt);
  if (stamps.every((stamp) => typeof stamp === "number")) {
    const newest = Math.max(...stamps);
    const latest = pool.filter((thread) => thread.activeAt === newest);
    if (latest.length === 1) return resolved(latest[0], false);
  }
  return resolved(pool[0], true);
}

/** Split `text` into plain runs and linked "#Title" runs. The linked run
 * keeps the person's own spelling ("#qa pr 245" stays as typed). */
export function resolveThreadRefs(text: string, threads: ThreadRefCandidate[], currentBotId?: string): ThreadRefSpan[] {
  const groups = groupTitles(threads);
  if (!groups.length || !text.includes("#")) return [{ text }];
  const spans: ThreadRefSpan[] = [];
  let last = 0;
  let at = text.indexOf("#");
  while (at !== -1) {
    const before = at > 0 ? text[at - 1] : "";
    const start = at + 1;
    let matched: { end: number; ref: ResolvedThreadRef } | null = null;
    if (!before || !NOT_WORD_START.test(before)) {
      for (const group of groups) {
        const end = start + group.lower.length;
        if (text.slice(start, end).toLowerCase() !== group.lower) continue;
        const after = text[end] ?? "";
        if (after && WORD_CHAR.test(after)) continue;
        matched = { end, ref: pick(group.candidates, currentBotId) };
        break;
      }
    }
    if (matched) {
      if (at > last) spans.push({ text: text.slice(last, at) });
      spans.push({ text: text.slice(at, matched.end), ref: matched.ref });
      last = matched.end;
      at = text.indexOf("#", matched.end);
    } else {
      at = text.indexOf("#", at + 1);
    }
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length ? spans : [{ text }];
}

// ── remark plugin ──────────────────────────────────────────────────────
// Splits markdown text nodes into thread-link nodes that render through
// the markdown `span` component as data-thread-* attributes. Code, links
// and images are left alone: a title inside backticks is being quoted.

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

const OPAQUE = new Set(["link", "linkReference", "image", "imageReference", "definition", "html", "mention"]);

export const THREAD_REF_NODE = "threadRef";

function linkNode(text: string, ref: ResolvedThreadRef): MdNode {
  return {
    type: THREAD_REF_NODE,
    data: {
      hName: "span",
      hProperties: {
        "data-thread-bot": ref.botId,
        "data-thread-bot-name": ref.botName,
        "data-thread-id": ref.threadId,
        "data-thread-title": ref.title,
        "data-thread-ambiguous": ref.ambiguous ? "true" : "false",
      },
    },
    children: [{ type: "text", value: text }],
  };
}

/** A unified attacher: `remarkPlugins={[remarkThreadRefs(threads, botId)]}`. */
export function remarkThreadRefs(threads: ThreadRefCandidate[], currentBotId?: string) {
  return () => (tree: MdNode) => {
    if (!threads.length) return;
    const visit = (node: MdNode) => {
      if (!node.children || OPAQUE.has(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          return [child];
        }
        const spans = resolveThreadRefs(child.value, threads, currentBotId);
        if (!spans.some((span) => span.ref)) return [child];
        return spans.map((span) => (span.ref ? linkNode(span.text, span.ref) : { type: "text", value: span.text }));
      });
    };
    visit(tree);
  };
}
