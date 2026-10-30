import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_WIDTH_IDS, DEFAULT_CHAT_WIDTH, applyChatWidth, readChatWidth } from "./chat-width";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "styles.css"), "utf8");
const blocks = new Set(
  [...css.matchAll(/:root\[data-chat-width="([a-z-]+)"\]/g)].map(([, id]) => id),
);

describe("chat width", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal("document", { documentElement: { dataset: {} as DOMStringMap } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("defaults to the standard width", () => {
    expect(DEFAULT_CHAT_WIDTH).toBe("standard");
    expect(readChatWidth()).toBe("standard");
  });

  it("sizes the standard width like Grok Bot: a 960px column and bubbles of min(80%, 560px)", () => {
    const body = css.match(/:root\s*\{\s*(--chat-bubble-max[^}]*)\}/)?.[1] ?? "";
    expect(body).toMatch(/--chat-bubble-max:\s*35rem/);
    expect(body).toMatch(/--chat-bubble-pct:\s*80%/);
    expect(body).toMatch(/--chat-card-pct:\s*88%/);
    expect(body).toMatch(/--chat-column-max:\s*60rem/);
  });

  it("gives every non-default width a stylesheet block that sets the bubble variables", () => {
    for (const id of CHAT_WIDTH_IDS.filter((w) => w !== DEFAULT_CHAT_WIDTH)) {
      expect(blocks).toContain(id);
      const body = css.match(new RegExp(`:root\\[data-chat-width="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body).toMatch(/--chat-bubble-max\s*:/);
      expect(body).toMatch(/--chat-bubble-pct\s*:/);
      expect(body).toMatch(/--chat-card-pct\s*:/);
    }
  });

  it.each(CHAT_WIDTH_IDS)("sizes the %s column so its bubbles still reach their cap", (id) => {
    const selector = id === DEFAULT_CHAT_WIDTH ? ":root" : `:root\\[data-chat-width="${id}"\\]`;
    const body = css.match(new RegExp(`${selector}\\s*\\{\\s*(--chat-bubble-max[^}]*)\\}`))?.[1] ?? "";
    const token = (name: string) => body.match(new RegExp(`--${name}:\\s*([\\d.]+)(rem|%)?`))?.slice(1) ?? [];
    const [column, columnUnit] = token("chat-column-max");
    const [bubble, bubbleUnit] = token("chat-bubble-max");
    const [pct] = token("chat-bubble-pct");
    expect(column, `${id} sets --chat-column-max`).toBeDefined();
    if (columnUnit === "rem" && bubbleUnit === "rem") {
      expect(Number(column) * Number(pct) / 100).toBeGreaterThanOrEqual(Number(bubble));
    }
  });

  it("centers the transcript and the composer in one column, in a chat and in a room", () => {
    expect(css).toMatch(/\.chat-column \{[^}]*margin-inline: auto;[^}]*max-width: var\(--chat-column-max\);/);
    expect(css).toMatch(/\.chat-column-dock \{[^}]*margin-inline: auto;[^}]*max-width: calc\(var\(--chat-column-max\) \+ 2\.5rem\);/);
    for (const f of ["ChatView", "GroupView"]) {
      const source = readFileSync(join(root, "components", `${f}.tsx`), "utf8");
      expect(source, f).toMatch(/className="glass-scroller-content chat-column /);
      expect(source, f).toMatch(/ref=\{composerDockRef\} className="[^"]* chat-column-dock"/);
    }
  });

  it("registers every stylesheet block", () => {
    for (const id of blocks) expect<readonly string[]>(CHAT_WIDTH_IDS).toContain(id);
  });

  it("stamps a chosen width, remembers it, and clears the attribute for the default", () => {
    applyChatWidth("full");
    expect(document.documentElement.dataset.chatWidth).toBe("full");
    expect(readChatWidth()).toBe("full");
    applyChatWidth(DEFAULT_CHAT_WIDTH);
    expect(document.documentElement.dataset.chatWidth).toBeUndefined();
    expect(readChatWidth()).toBe("standard");
  });

  it("ignores an unknown stored value", () => {
    localStorage.setItem("omb-chat-width", "huge");
    expect(readChatWidth()).toBe("standard");
  });

  it.each(CHAT_WIDTH_IDS)("restores %s before paint without changing other appearance preferences", (id) => {
    localStorage.setItem("omb-chat-width", id);
    localStorage.setItem("omb-color-user-bubbles", "1");
    document.documentElement.dataset.skin = "midnight";
    applyChatWidth(readChatWidth());
    expect(document.documentElement.dataset.chatWidth).toBe(id === DEFAULT_CHAT_WIDTH ? undefined : id);
    expect(document.documentElement.dataset.skin).toBe("midnight");
    expect(localStorage.getItem("omb-color-user-bubbles")).toBe("1");
  });

  it("still applies a session choice when storage cannot be read or written", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
    });
    expect(readChatWidth()).toBe("standard");
    expect(() => applyChatWidth("wide")).not.toThrow();
    expect(document.documentElement.dataset.chatWidth).toBe("wide");
    applyChatWidth("standard");
    expect(document.documentElement.dataset.chatWidth).toBeUndefined();
  });

  it("leaves no hard-coded 42rem bubble cap in the components", () => {
    for (const f of ["ChatView", "GroupView", "MessageBoundary", "ScreenFrame", "RoutineRunCard", "GoalRunCard", "widget/WidgetMessage"]) {
      expect(readFileSync(join(root, "components", `${f}.tsx`), "utf8")).not.toMatch(/min\(42rem/);
    }
  });
});
