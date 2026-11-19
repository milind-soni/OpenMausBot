// Counts the components each React commit renders, by name and by the transcript row (the nearest `data-mid` above
// them), through the hook React's developer tools attach to. React reads the hook once, when react-dom loads: import
// this module before anything that loads react-dom.
interface Fiber {
  tag: number;
  type: unknown;
  flags: number;
  alternate: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: Record<string, unknown> | null;
}

export interface Rendered {
  component: string;
  row: string | null;
}

const FUNCTION = 0, CLASS = 1, HOST = 5, FORWARD_REF = 11, MEMO = 14, SIMPLE_MEMO = 15;
const PERFORMED_WORK = 1;
const COMPONENTS = new Set([FUNCTION, CLASS, FORWARD_REF, MEMO, SIMPLE_MEMO]);

const rendered: Rendered[] = [];

/** The component's own name: the module transform renames a memo's inner function, `Bubble` to `Bubble2`. */
function nameOf(fiber: Fiber): string {
  const type = fiber.type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | null;
  return (type?.displayName || type?.name || type?.render?.name || type?.type?.name || "anonymous").replace(/(?<=\D)\d+$/, "");
}

/** A subtree React skipped keeps the very child it had, and its fibers still carry the flags of the commit that last drew them. */
function walk(first: Fiber, row: string | null): void {
  for (let fiber: Fiber | null = first; fiber; fiber = fiber.sibling) {
    const mounted = fiber.alternate === null;
    const mid = fiber.tag === HOST ? fiber.memoizedProps?.["data-mid"] : undefined;
    const here = typeof mid === "string" ? mid : row;
    if (COMPONENTS.has(fiber.tag) && (mounted || (fiber.flags & PERFORMED_WORK) !== 0)) rendered.push({ component: nameOf(fiber), row: here });
    if (fiber.child && (mounted || fiber.child !== fiber.alternate!.child)) walk(fiber.child, here);
  }
}

const target = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
if (target.__REACT_DEVTOOLS_GLOBAL_HOOK__) throw new Error("render-counts: another developer-tools hook is installed");
const renderers = new Map<number, unknown>();
target.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  renderers,
  inject(renderer: unknown) {
    renderers.set(renderers.size + 1, renderer);
    return renderers.size;
  },
  onScheduleFiberRoot() {},
  onCommitFiberRoot(_id: number, root: { current: Fiber }) {
    walk(root.current, null);
  },
  onCommitFiberUnmount() {},
  onPostCommitFiberRoot() {},
  setStrictMode() {},
  checkDCE() {},
};

/** Where the count stands now; pass it to `renderedSince`. */
export function renderMark(): number {
  return rendered.length;
}

export function renderedSince(mark: number): readonly Rendered[] {
  return rendered.slice(mark);
}

export function countBy<K extends string | null>(list: readonly Rendered[], key: (entry: Rendered) => K): Map<K, number> {
  const counts = new Map<K, number>();
  for (const entry of list) counts.set(key(entry), (counts.get(key(entry)) ?? 0) + 1);
  return counts;
}
