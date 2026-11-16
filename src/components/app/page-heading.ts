const UNSEEN = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "TITLE"]);

function firstText(node: Node): Text | null {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      if (child.textContent?.trim()) return child as Text;
    } else if (child.nodeType === 1 && !UNSEEN.has((child as Element).tagName) && !(child as Element).hasAttribute("hidden")) {
      const found = firstText(child);
      if (found) return found;
    }
  }
  return null;
}

/** Whether the first words of a page's markup are a heading of its own. A page that draws itself with a script has none. */
export function pageOpensWithHeading(srcdoc: string): boolean {
  if (typeof DOMParser === "undefined") return false;
  const body = new DOMParser().parseFromString(srcdoc, "text/html").body;
  return Boolean(body && firstText(body)?.parentElement?.closest("h1, h2, h3, [role=heading]"));
}
