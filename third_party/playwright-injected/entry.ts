// The page-side half of the built-in browser's snapshot: Playwright's
// accessibility-tree snapshot (the `[ref=e12]` YAML that playwright-mcp
// hands models), bundled into one script and evaluated in a bot's tab over
// CDP. Nothing here talks to Electron; it only knows the DOM.
//
// Everything under ./src and ./isomorphic is vendored from Microsoft
// Playwright (Apache-2.0, see LICENSE and UPSTREAM_COMMIT) unmodified. This
// file is ours: it exposes the pieces the surface needs on `window.__ombBrowser`
// and keeps the ref → element table of the last snapshot so a click on
// `e12` resolves to the element the model was shown.
import { generateAriaTree, renderAriaTreeAsJSON, type AriaSnapshot } from "./src/ariaSnapshot";
import { renderAriaSnapshotAsYaml } from "./isomorphic/ariaSnapshotRenderer";

const VERSION = 1;
const DEFAULT_MAX_CHARS = 60_000;

let last: AriaSnapshot | null = null;
let lastIntegrity = new Map<string, string>();

type SnapshotResult = {
  version: number;
  yaml: string;
  refs: string[];
  truncated: boolean;
  iframes: number;
};

type BoxResult =
  | { found: false }
  | { found: true; connected: false }
  | { found: true; connected: true; visible: boolean; x: number; y: number; width: number; height: number };

function nodesByRef(root: AriaSnapshot["root"]): Map<string, AriaSnapshot["root"]> {
  const byRef = new Map<string, AriaSnapshot["root"]>();
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.ref)
      byRef.set(node.ref, node);
    for (const child of node.children) {
      if (typeof child !== "string")
        pending.push(child);
    }
  }
  return byRef;
}

/** Facts the model reviewed before receiving a ref. Keep coordinates and
 * live values out (normal layout and typing may change those), but bind the
 * ref to the same DOM object, accessible meaning and actionability. */
function integritySignature(node: AriaSnapshot["root"], element: Element): string {
  const attributes = Array.from(element.attributes)
    .map(attribute => [attribute.name, attribute.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const properties = Object.entries(node.props)
    .sort(([left], [right]) => left.localeCompare(right));
  const control = element as Element & {
    disabled?: boolean;
    readOnly?: boolean;
    tabIndex?: number;
    isContentEditable?: boolean;
  };
  return JSON.stringify({
    role: node.role,
    name: node.name,
    properties,
    tag: element.tagName,
    attributes,
    disabled: control.disabled === true,
    readOnly: control.readOnly === true,
    tabIndex: Number.isInteger(control.tabIndex) ? control.tabIndex : null,
    contentEditable: control.isContentEditable === true,
    visible: node.box.visible,
    receivesPointerEvents: node.receivesPointerEvents,
  });
}

function recordIntegrity(tree: AriaSnapshot): Map<string, string> {
  const result = new Map<string, string>();
  const nodes = nodesByRef(tree.root);
  for (const [ref, info] of tree.info) {
    const node = nodes.get(ref);
    if (node)
      result.set(ref, integritySignature(node, info.element));
  }
  return result;
}

function snapshot(maxChars: number = DEFAULT_MAX_CHARS): SnapshotResult {
  const root = document.body ?? document.documentElement;
  const tree = generateAriaTree(root, { mode: "ai" });
  last = tree;
  lastIntegrity = recordIntegrity(tree);
  const { json } = renderAriaTreeAsJSON(tree, { mode: "ai" });
  let yaml = renderAriaSnapshotAsYaml(json);
  let truncated = false;
  if (yaml.length > maxChars) {
    // Do not point at browser_read here: it caps lower than this snapshot
    // does, so it returns a shorter prefix, never the remainder. Say what
    // this is (document order, not the viewport) so the reader does not try
    // to scroll for the rest.
    yaml = `${yaml.slice(0, maxChars)}\n…(snapshot truncated at ${maxChars} characters — the start of the page in document order, not the visible part. Scrolling does not reveal the rest; work from a narrower page.)`;
    truncated = true;
  }
  return { version: VERSION, yaml, refs: [...tree.info.keys()], truncated, iframes: tree.iframeRefs.length };
}

function elementForRef(ref: string): Element | null {
  return last?.info.get(ref)?.element ?? null;
}

/** Rebuild the current accessibility facts without replacing the reviewed
 * snapshot. A ref is usable only while it still names the exact same DOM
 * element with the same role, name and actionability. */
function validateRef(ref: string): boolean {
  const element = elementForRef(ref);
  const reviewed = lastIntegrity.get(ref);
  const root = document.body ?? document.documentElement;
  if (!element || !reviewed || !root || !element.isConnected)
    return false;
  const current = generateAriaTree(root, { mode: "ai" });
  const currentRef = current.refs.get(element);
  if (currentRef !== ref)
    return false;
  const currentNode = nodesByRef(current.root).get(currentRef);
  return currentNode ? integritySignature(currentNode, element) === reviewed : false;
}

function composedContains(ancestor: Node, candidate: Node | null): boolean {
  for (let current = candidate; current;) {
    if (current === ancestor)
      return true;
    const root = current.getRootNode();
    current = current.parentNode ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

function deepestElementAtPoint(x: number, y: number): Element | null {
  let hit = document.elementFromPoint(x, y);
  for (let depth = 0; hit && depth < 16; depth += 1) {
    const inner = hit.shadowRoot?.elementFromPoint(x, y);
    if (!inner || inner === hit)
      break;
    hit = inner;
  }
  return hit;
}

/** The reviewed target must still be what Chromium will hit. This catches a
 * page that places a transparent/full-page overlay after the snapshot. */
function hitTestRef(ref: string, x: number, y: number): boolean {
  const element = elementForRef(ref);
  const hit = deepestElementAtPoint(x, y);
  if (!element || !hit || !element.isConnected)
    return false;
  return composedContains(element, hit) || composedContains(hit, element);
}

/** Two presented frames, or a short wait when the view is throttled (an
 * occluded or unfocused view may never run requestAnimationFrame). */
const nextFrames = (count: number, maxMs = 150): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const tick = (left: number) => (left <= 0 ? finish() : requestAnimationFrame(() => tick(left - 1)));
    tick(count);
    setTimeout(finish, maxMs);
  });

/** Where a ref is on screen right now. Scrolls it into view first, the
 * same way a person would before clicking, then lets the compositor catch
 * up: synthetic input is hit-tested against the last presented frame, so a
 * click dispatched in the same task as the scroll lands on stale pixels. */
async function boxForRef(ref: string): Promise<BoxResult> {
  const element = elementForRef(ref);
  if (!element) return { found: false };
  if (!element.isConnected) return { found: true, connected: false };
  try {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  } catch {
    // some elements refuse; the rect below is still the truth
  }
  await nextFrames(2);
  const rect = element.getBoundingClientRect();
  const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  return {
    found: true,
    connected: true,
    visible,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
  };
}

function focusRef(ref: string): boolean {
  const element = elementForRef(ref);
  if (!element) return false;
  const focusable = element as HTMLElement & { focus?: () => void };
  if (focusable.focus) focusable.focus();
  return document.activeElement === element || element.contains(document.activeElement);
}

declare global {
  interface Window {
    __ombBrowser?: {
      version: number;
      snapshot: typeof snapshot;
      elementForRef: typeof elementForRef;
      validateRef: typeof validateRef;
      hitTestRef: typeof hitTestRef;
      boxForRef: typeof boxForRef;
      focusRef: typeof focusRef;
    };
  }
}

window.__ombBrowser = { version: VERSION, snapshot, elementForRef, validateRef, hitTestRef, boxForRef, focusRef };
