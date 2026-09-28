import { Children, createElement, isValidElement, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { t } from "@/lib/i18n";
import { AttentionThreadRows, type AttentionThread } from "./SidebarBotActivity";
import { SidebarAttentionPanel } from "./SidebarAttentionPanel";

const entry: AttentionThread = {
  kind: "bot",
  botId: "atlas",
  botName: "Atlas",
  task: { threadId: "approval", title: "Review permission", createdAt: 1, queued: false, activity: "waiting-on-you" },
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

function renderPanel(entries: AttentionThread[] = [entry]) {
  let tree: ReactNode;
  const onUnpin = vi.fn();
  const onJump = vi.fn();
  function Capture() {
    tree = SidebarAttentionPanel({ entries, density: "comfortable", onUnpin, onJump });
    return tree;
  }
  const markup = renderToStaticMarkup(createElement(Capture));
  return { markup, tree: () => tree as ReactNode, onUnpin, onJump };
}

describe("pinned attention panel", () => {
  it("renders the popover's rows under the Active Threads name", () => {
    const { markup } = renderPanel();
    expect(markup).toContain("Active Threads");
    expect(markup).toContain("Review permission");
    expect(markup).toContain("Atlas");
    expect(markup).toContain('data-testid="sidebar-attention-panel"');
    // the inline section reuses the popover rows, labels and all
    const label = t("attention.item", { title: "Review permission", name: "Atlas", status: t("task.waiting") });
    expect(markup).toContain('aria-label="' + label + '"');
  });

  it("keeps the popover's jump behavior through the shared rows", () => {
    let tree: ReactNode;
    const onJump = vi.fn();
    function Capture() {
      tree = AttentionThreadRows({ entries: [entry], onJump });
      return tree;
    }
    renderToStaticMarkup(createElement(Capture));
    const label = t("attention.item", { title: "Review permission", name: "Atlas", status: t("task.waiting") });
    findElement(tree as ReactNode, "aria-label", label)!.props.onClick!({} as MouseEvent);
    expect(onJump).toHaveBeenCalledExactlyOnceWith(entry);
  });

  it("collapses to the header row plus the empty label when nothing is active", () => {
    const { markup } = renderPanel([]);
    expect(markup).toContain("Active Threads");
    expect(markup).toContain("No active threads");
    expect(markup).not.toContain("Review permission");
  });

  it("unpins from the inline header", () => {
    const { tree, onUnpin } = renderPanel();
    findElement(tree(), "aria-label", "Unpin")!.props.onClick!({} as MouseEvent);
    expect(onUnpin).toHaveBeenCalledOnce();
  });
});
