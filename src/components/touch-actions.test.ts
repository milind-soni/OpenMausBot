import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

// Tailwind v4 wraps every `hover:`/`group-hover:` rule in
// `@media (hover: hover)`, so on a phone or tablet a control that is
// `opacity-0 group-hover:opacity-100` never becomes visible: it is either
// invisible or only reachable by a lucky tap. Every hover-revealed action
// therefore needs a `touch:` counterpart (the custom variant in styles.css)
// and a keyboard-focus reveal.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");
const stylesPath = join(srcRoot, "styles.css");
const styles = readFileSync(stylesPath, "utf8");

// Hover-only details that are not actions. Keyed by file and a snippet of the
// class string so a stale entry fails below instead of silently widening.
const notActions: Array<{ file: string; snippet: string; why: string }> = [
  { file: "components/ChatView.tsx", snippet: "self-end pb-1 text-[11px] tabular-nums", why: "message timestamp, informational" },
  { file: "components/GroupView.tsx", snippet: "self-end pb-1 text-[11px] tabular-nums", why: "message timestamp, informational" },
  { file: "components/ScreenFrame.tsx", snippet: "group-hover/image:opacity-100", why: "aria-hidden zoom hint; the whole image is the tap target" },
  { file: "components/AttachmentPreview.tsx", snippet: "group-hover/image:opacity-100", why: "zoom hint; the whole image is the tap target" },
  { file: "components/remote-desktop-panel.tsx", snippet: "bg-black/65 py-2", why: "caption; the whole preview is the tap target" },
  { file: "components/routines/CalendarSidebar.tsx", snippet: "text-[8.5px]", why: "'Drag' hint badge, not a control" },
  { file: "components/RoutineCalendarPage.tsx", snippet: "cursor-ns-resize", why: "mouse drag-resize handle for call events" },
  { file: "components/ComputerPanel.tsx", snippet: "opacity-80", why: "already visible at 80% without hover" },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

type Literal = { file: string; line: number; text: string };

function classLiterals(): Literal[] {
  const found: Literal[] = [];
  for (const path of sourceFiles(srcRoot)) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/"([^"\n]*)"|`([^`]*)`/g)) {
      const text = match[1] ?? match[2] ?? "";
      if (!/group-hover(?:\/[\w-]+)?:/.test(text)) continue;
      found.push({
        file: relative(srcRoot, path).split("\\").join("/"),
        line: source.slice(0, match.index).split("\n").length,
        text,
      });
    }
  }
  return found;
}

// The utilities that hide or make room for a hover-revealed control.
const revealUtility = /group-hover(?:\/[\w-]+)?:(opacity-\d+|pointer-events-auto|pr-\[[^\]]+\])/g;

function missingTouchCounterparts(literal: Literal): string[] {
  const tokens = literal.text.split(/\s+/);
  const missing: string[] = [];
  for (const [, utility] of literal.text.matchAll(revealUtility)) {
    const has =
      utility === "opacity-0"
        ? tokens.includes("touch:opacity-0")
        : utility.startsWith("opacity-")
          ? tokens.some((token) => /^touch:opacity-(?:[1-9]\d*)$/.test(token))
          : tokens.includes(`touch:${utility}`);
    if (!has) missing.push(utility);
  }
  return missing;
}

function revealsOnFocus(text: string): boolean {
  return /(^|\s)(focus-visible|focus-within|group-focus-within(?:\/[\w-]+)?):opacity-100(\s|$)/.test(text);
}

function isNotAction(literal: Literal): boolean {
  return notActions.some((entry) => entry.file === literal.file && literal.text.includes(entry.snippet));
}

describe("hover-only actions on touch screens", () => {
  it("defines a touch variant for devices without hover", () => {
    expect(/@custom-variant touch \{\s*@media \(hover: none\), \(pointer: coarse\) \{\s*@slot;/.test(styles)).toBe(true);
  });

  it("compiles touch: utilities inside the no-hover media query and leaves hover gated to mice", async () => {
    const tailwindRoot = dirname(fileURLToPath(import.meta.resolve("tailwindcss/package.json")));
    const compiler = await compile(styles, {
      base: srcRoot,
      loadStylesheet: async (id, base) => {
        const path = id === "tailwindcss" ? join(tailwindRoot, "index.css") : id.startsWith("tailwindcss/")
          ? join(tailwindRoot, id.slice("tailwindcss/".length))
          : join(base, id);
        return { path, base: dirname(path), content: readFileSync(path, "utf8") };
      },
    });
    const css = compiler.build(["touch:opacity-100", "group-hover:opacity-100"]);
    // one media query holding both conditions; a comma in the shorthand
    // variant form would be read as a selector list and break the rule
    expect(css).toMatch(/@media \(hover: none\), \(pointer: coarse\) \{\s*\.touch\\:opacity-100 \{\s*opacity: 100%;/);
    expect(css).not.toMatch(/\.touch\\:opacity-\d+ \(pointer/);
    // desktop keeps its hover-only rule: nothing about the mouse path changes
    expect(css).toMatch(/@media \(hover: hover\) \{\s*\.group-hover\\:opacity-100:is\(:where\(\.group\):hover \*\)/);
  });

  it("finds the hover-revealed controls it guards", () => {
    const literals = classLiterals().filter((literal) => !isNotAction(literal));
    // copy/raw/speak/pin/reply/actions in chat and group chat, the composer
    // chip remove, thread list buttons, and sidebar row buttons
    expect(literals.length).toBeGreaterThanOrEqual(19);
  });

  it("gives every hover-revealed action a touch fallback", () => {
    const offenders = classLiterals()
      .filter((literal) => !isNotAction(literal))
      .flatMap((literal) => {
        const missing = missingTouchCounterparts(literal);
        return missing.length ? [`${literal.file}:${literal.line} needs touch:${missing.join(", touch:")}`] : [];
      });
    expect(offenders).toEqual([]);
  });

  it("reveals every hover-revealed action on keyboard focus", () => {
    const offenders = classLiterals()
      .filter((literal) => !isNotAction(literal) && /group-hover(?:\/[\w-]+)?:opacity-100/.test(literal.text))
      .filter((literal) => !revealsOnFocus(literal.text))
      .map((literal) => `${literal.file}:${literal.line}`);
    expect(offenders).toEqual([]);
  });

  it("keeps the not-an-action list current", () => {
    const literals = classLiterals();
    const stale = notActions.filter(
      (entry) => !literals.some((literal) => literal.file === entry.file && literal.text.includes(entry.snippet)),
    );
    expect(stale).toEqual([]);
  });
});
