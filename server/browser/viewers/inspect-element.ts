import type { Tab } from "../tabs.ts";
const SOURCE = String.raw`function inspectElementAt({ x, y }) {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= innerWidth ||
    y >= innerHeight
  )
    throw Error("Select inside the webpage.");
  let el = document.elementFromPoint(x, y);
  while (el?.shadowRoot?.elementFromPoint) {
    const next = el.shadowRoot.elementFromPoint(x, y);
    if (!next || next === el) break;
    el = next;
  }
  if (
    !el ||
    ["HTML", "BODY", "IFRAME", "INPUT", "TEXTAREA", "SELECT"].includes(
      el.tagName,
    ) ||
    el.closest("[contenteditable],[data-private],[data-sensitive]") ||
    el.querySelector(
      "input,textarea,select,[contenteditable],[data-private],[data-sensitive]",
    )
  )
    throw Error(
      "Select a smaller element without private or editable content.",
    );
  const b = el.getBoundingClientRect(),
    left = Math.max(0, b.left),
    top = Math.max(0, b.top),
    right = Math.min(innerWidth, b.right),
    bottom = Math.min(innerHeight, b.bottom);
  if (right - left < 3 || bottom - top < 3)
    throw Error("Select a visible element.");
  // Check the whole clip: a sibling can cover pixels away from the pointer.
  // Carry privacy through light DOM and open shadow roots, including wrappers
  // whose own rectangle is empty. Reject pages beyond the bounded scan budget.
  const privateSelector =
    "input,textarea,select,iframe,[contenteditable],[data-private],[data-sensitive]";
  const refuse = () => {
    throw Error("Select a smaller element without private or editable content.");
  };
  const parentOf = (node) =>
    node.assignedSlot || node.parentElement || node.getRootNode().host;
  let ancestor = el;
  for (let depth = 0; ancestor; depth++, ancestor = parentOf(ancestor)) {
    if (depth >= 128 || ancestor.matches(privateSelector)) refuse();
  }
  const pending = [{ node: document.documentElement, private: false, selected: false }];
  let visited = 0;
  while (pending.length) {
    if (++visited > 5000) refuse();
    const entry = pending.pop();
    const node = entry.node;
    const sensitive = entry.private || node.matches(privateSelector);
    const selected = entry.selected || node === el;
    if (sensitive) {
      if (selected) refuse();
      const bounds = node.getBoundingClientRect();
      if (bounds.right > left && bounds.left < right &&
          bounds.bottom > top && bounds.top < bottom) refuse();
    }
    const children = [node.children, node.shadowRoot?.children];
    if (node.tagName === "SLOT" && node.assignedElements)
      children.push(node.assignedElements());
    for (const group of children) {
      if (!group) continue;
      if (visited + pending.length + group.length > 5000) refuse();
      for (const child of group)
        pending.push({ node: child, private: sensitive, selected });
    }
  }
  const parts = [];
  let node = el;
  for (let i = 0; node && i < 5; i++, node = node.parentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      part += "#" + CSS.escape(node.id);
      parts.unshift(part);
      break;
    }
    const siblings = node.parentElement
      ? Array.from(node.parentElement.children).filter(
          (n) => n.tagName === node.tagName,
        )
      : [];
    if (siblings.length > 1)
      part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
    parts.unshift(part);
  }
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return {
    selector: parts.join(" > "),
    tag: el.tagName.toLowerCase(),
    label: (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      (el.children.length ? "" : el.textContent) ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160),
    url: url.href,
    document: String(performance.timeOrigin) + ":" + location.href,
    rect: { x: left, y: top, width: right - left, height: bottom - top },
    clip: {
      x: left + scrollX,
      y: top + scrollY,
      width: right - left,
      height: bottom - top,
    },
  };
}`;
interface ElementInspection {
  rect: { x: number; y: number; width: number; height: number };
  clip: { x: number; y: number; width: number; height: number };
  document: string;
}
export async function inspectBrowserElement(
  viewer: { push(message: Record<string, unknown>): void },
  tab: Tab,
  message: Record<string, unknown>,
) {
  const id = message.requestId;
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
    !Number.isFinite(message.x) ||
    !Number.isFinite(message.y)
  )
    return;
  try {
    const element = (await tab.page.evaluate(
      "(" +
        SOURCE +
        ")(" +
        JSON.stringify({ x: message.x, y: message.y }) +
        ")",
      { world: "isolated", timeoutMs: 3000 },
    )) as ElementInspection | null;
    if (!element || !element.rect || !element.clip)
      throw Error("The webpage element is no longer available.");
    if (message.document && message.document !== element.document)
      throw Error("The page changed. Select the element again.");
    let image: string | undefined;
    if (message.capture === true) {
      const shot = await tab.page.screenshot({
        format: "png",
        clip: element.clip,
      });
      const current = (await tab.page.evaluate(
        "(" +
          SOURCE +
          ")(" +
          JSON.stringify({ x: message.x, y: message.y }) +
          ")",
        { world: "isolated", timeoutMs: 3000 },
      )) as ElementInspection | null;
      if (
        !current ||
        current.document !== element.document ||
        JSON.stringify(current.rect) !== JSON.stringify(element.rect)
      ) {
        throw Error("The page changed. Select the element again.");
      }
      if (shot.data.length > 8 * 1024 * 1024)
        throw Error("Select a smaller element.");
      image = shot.data.toString("base64");
    }
    viewer.push({
      type: "ombElementInspection",
      requestId: id,
      element,
      ...(image ? { image, mime: "image/png" } : {}),
    });
  } catch (error) {
    viewer.push({
      type: "ombElementInspection",
      requestId: id,
      error:
        error instanceof Error
          ? error.message.slice(0, 300)
          : "Element capture failed.",
    });
  }
}
