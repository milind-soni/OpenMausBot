import { Children, createElement, isValidElement, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { t } from "@/lib/i18n";
import { PinnedThreadRows, type AttentionThread } from "./SidebarBotActivity";
import { SidebarPinnedThreadsPanel } from "./SidebarPinnedThreadsPanel";

const entry: AttentionThread = {
  kind: "bot",
  botId: "atlas",
  botName: "Atlas",
  task: { threadId: "pinned-1", title: "Quarterly plan", createdAt: 1, queued: false },
};

type ElementProps = { children?: ReactNode; onClick?: (event: MouseEvent) => void; [key: string]: unknown };
function findElement(tree: ReactNode, attribute: string, value: string): ReactElement<ElementProps> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (child.props[attribute] === value) return child;
    const found = findElement(child.props.children, attribute, value);
    if (found) return found;
  }
}

function renderPanel(
  entries: AttentionThread[] = [entry],
  options: { collapsed?: boolean; onToggle?: () => void; onUnpin?: (entry: AttentionThread) => void } = {},
) {
  let tree: ReactNode;
  const onJump = vi.fn();
  const onToggle = options.onToggle ?? vi.fn();
  const onUnpin = options.onUnpin ?? vi.fn();
  function Capture() {
    tree = SidebarPinnedThreadsPanel({
      entries,
      density: "comfortable",
      now: 1,
      onJump,
      collapsed: options.collapsed ?? false,
      onToggle,
      onUnpin,
    });
    return tree;
  }
  const markup = renderToStaticMarkup(createElement(Capture));
  return { markup, tree: () => tree as ReactNode, onJump, onToggle, onUnpin };
}

function renderRows(entries: AttentionThread[]) {
  let tree: ReactNode;
  const onJump = vi.fn();
  const onUnpin = vi.fn();
  function Capture() {
    tree = PinnedThreadRows({ entries, now: 1, onJump, onUnpin });
    return tree;
  }
  const markup = renderToStaticMarkup(createElement(Capture));
  return { markup, tree: () => tree as ReactNode, onJump, onUnpin };
}

describe("pinned threads panel", () => {
  it("renders nothing when there is no pinned thread", () => {
    const { markup } = renderPanel([]);
    expect(markup).toBe("");
  });

  it("renders the pinned rows under the Pinned threads name", () => {
    const { markup } = renderPanel();
    expect(markup).toContain(t("sidebar.pinnedThreads.title"));
    expect(markup).toContain("Quarterly plan");
    expect(markup).toContain("Atlas");
    expect(markup).toContain('data-testid="sidebar-pinned-threads-panel"');
  });

  it("hides the rows but keeps the header when collapsed", () => {
    const { markup } = renderPanel([entry], { collapsed: true });
    expect(markup).toContain(t("sidebar.pinnedThreads.title"));
    expect(markup).not.toContain("Quarterly plan");
    const label = t("sidebar.section.expand", { name: t("sidebar.pinnedThreads.title") });
    expect(markup).toContain('aria-label="' + label + '"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it("toggles from the collapse/expand control", () => {
    const { tree, onToggle } = renderPanel([entry], { collapsed: false });
    const label = t("sidebar.section.collapse", { name: t("sidebar.pinnedThreads.title") });
    findElement(tree(), "aria-label", label)!.props.onClick!({} as MouseEvent);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("disables collapse when search prevents layout changes", () => {
    const markup = renderToStaticMarkup(createElement(SidebarPinnedThreadsPanel, {
      entries: [entry], density: "comfortable", now: 1, onUnpin: vi.fn(), onJump: vi.fn(), collapsed: false,
    }));
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]+aria-expanded="true"/);
    expect(markup).toContain("Quarterly plan");
  });

});

describe("pinned thread rows", () => {
  it("shows the plain Pin icon and a time byline for an idle pinned thread", () => {
    const { markup } = renderRows([entry]);
    expect(markup).toContain("lucide-pin ");
    expect(markup).not.toContain("lucide-circle-alert");
    expect(markup).not.toContain("lucide-loader");
    expect(markup).toContain("Atlas · just now");
  });

  it("shows the live status icon and word for an actively working pinned thread", () => {
    const working: AttentionThread = {
      kind: "bot", botId: "atlas", botName: "Atlas",
      task: { threadId: "pinned-2", title: "Build report", createdAt: 1, queued: false, busy: true, activity: "working" },
    };
    const { markup } = renderRows([working]);
    expect(markup).toContain("lucide-loader");
    expect(markup).not.toContain("lucide-pin ");
    expect(markup).toContain("Atlas · " + t("chat.activity.working"));
  });

  it("shows the waiting icon and word for a pinned thread waiting on the person", () => {
    const waiting: AttentionThread = {
      kind: "bot", botId: "atlas", botName: "Atlas",
      task: { threadId: "pinned-3", title: "Needs approval", createdAt: 1, queued: false, activity: "waiting-on-you" },
    };
    const { markup } = renderRows([waiting]);
    expect(markup).toContain("lucide-circle-alert");
    expect(markup).toContain("Atlas · " + t("task.waiting"));
  });

  it("calls onUnpin for the row's own entry, not onJump, from the per-row unpin button", () => {
    const { tree, onUnpin, onJump } = renderRows([entry]);
    const label = t("sidebar.bot.unpin");
    findElement(tree(), "aria-label", label)!.props.onClick!({} as MouseEvent);
    expect(onUnpin).toHaveBeenCalledWith(entry);
    expect(onJump).not.toHaveBeenCalled();
  });
});
