import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const portal = vi.hoisted(() => vi.fn((children: ReactNode, _container: unknown) => children));
vi.mock("react-dom", () => ({
  createPortal: (children: ReactNode, target: unknown) => portal(children, target),
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { instances: [] } }),
  api: vi.fn(),
}));

import { CommandAllowlistDialog } from "./CommandAllowlistDialog";

type Node = ReactElement<{
  children?: ReactNode;
  onClick?: () => void;
  onMouseDown?: (event: { stopPropagation: () => void; target?: unknown; currentTarget?: unknown }) => void;
  "aria-label"?: string;
  style?: { WebkitAppRegion?: string };
}>;

function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}

function render(onClose: () => void) {
  let tree: ReactNode = null;
  function Capture() {
    tree = CommandAllowlistDialog({ botId: "bot-1", botName: "Scout", onClose });
    return tree;
  }
  return { html: renderToStaticMarkup(createElement(Capture)), nodes: nodes(tree) };
}

describe("CommandAllowlistDialog close button", () => {
  afterEach(() => {
    portal.mockClear();
    vi.unstubAllGlobals();
  });

  it("closes from the X and opts the overlay out of the window drag region", () => {
    const body = {};
    vi.stubGlobal("document", { body });
    const onClose = vi.fn();
    const view = render(onClose);
    const close = view.nodes.find((node) => node.props["aria-label"] === "Close command allowlist");
    expect(close?.type).toBe("button");
    close!.props.onClick!();
    expect(onClose).toHaveBeenCalledOnce();
    const stop = vi.fn();
    close!.props.onMouseDown!({ stopPropagation: stop });
    expect(stop).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    const overlay = view.nodes.find((node) => node.props.style?.WebkitAppRegion === "no-drag");
    expect(overlay?.props.style).toEqual({ WebkitAppRegion: "no-drag" });
    expect(view.html).toContain("-webkit-app-region:no-drag");
    expect(view.html).toContain("pointer-events-none");
    expect(portal).toHaveBeenCalledWith(expect.anything(), body);
  });
});
