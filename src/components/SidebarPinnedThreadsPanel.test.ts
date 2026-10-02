import { Children, createElement, isValidElement, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { t } from "@/lib/i18n";
import type { AttentionThread } from "./SidebarBotActivity";
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
  options: { collapsed?: boolean; onToggle?: () => void } = {},
) {
  let tree: ReactNode;
  const onJump = vi.fn();
  const onToggle = options.onToggle ?? vi.fn();
  function Capture() {
    tree = SidebarPinnedThreadsPanel({
      entries,
      density: "comfortable",
      now: 1,
      onJump,
      collapsed: options.collapsed ?? false,
      onToggle,
    });
    return tree;
  }
  const markup = renderToStaticMarkup(createElement(Capture));
  return { markup, tree: () => tree as ReactNode, onJump, onToggle };
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
});
