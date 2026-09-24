import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: store.api, useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
vi.mock("@/lib/analytics", () => ({ identifyEmail: vi.fn(), track: vi.fn() }));
import { HelloBeat } from "./HelloBeat";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() };
function render(hosted?: boolean) {
  let tree: ReactNode = null;
  function Capture() {
    tree = HelloBeat({ ...props, ...(hosted === undefined ? {} : { hosted }) });
    return tree;
  }
  return { html: renderToStaticMarkup(createElement(Capture)), tree };
}

beforeEach(() => {
  store.api.mockReset();
  props.onNext.mockReset();
  setLocale("en");
});

describe("the greeting beat", () => {
  it("asks a hosted workspace for nothing and saves nothing", () => {
    const { html, tree } = render(true);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("let you know when big things ship");
    expect(html).toContain("shared workspace");
    expect(html).toContain("nothing to install");
    // Continue moves on; there is nothing to save
    const primary = nodes(tree).find((node) => typeof node.type === "function" && node.props.onClick);
    primary!.props.onClick!();
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(store.api).not.toHaveBeenCalled();
  });

  it("keeps the desktop greeting with its name and email fields", () => {
    for (const html of [render().html, render(false).html]) {
      expect(html).toContain("you@example.com");
      expect(html).toContain("let you know when big things ship");
      expect(html).not.toContain("shared workspace");
    }
  });
});
