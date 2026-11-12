import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { QuotaSwitchSetting } from "./QuotaSwitchSetting";
import { Switch } from "./SettingsPrimitives";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0,
  config: {} as Pick<ConfigStatus, "features"> | null,
  api: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = QuotaSwitchSetting(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, toggle: nodes(tree).find((node) => node.type === Switch)! };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  fixture.values = [];
  fixture.config = { features: { skillAuthoring: true } };
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
});

describe("QuotaSwitchSetting", () => {
  it("shows the switch on by default and turns it off with one click", async () => {
    const { html, toggle } = render();
    expect(html).toContain("Switch AI at a usage limit");
    expect(toggle.props.checked).toBe(true);
    const saved = { features: { skillAuthoring: true, quotaSwitch: false } };
    fixture.api.mockResolvedValue(saved);
    (toggle.props.onClick as () => void)();
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { quotaSwitch: false } }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved });
  });

  it("shows off when the server reports it off, and turns it back on", async () => {
    fixture.config = { features: { skillAuthoring: true, quotaSwitch: false } };
    const { toggle } = render();
    expect(toggle.props.checked).toBe(false);
    fixture.api.mockResolvedValue({ features: { skillAuthoring: true, quotaSwitch: true } });
    (toggle.props.onClick as () => void)();
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { quotaSwitch: true } }) });
  });

  it("shows the error when saving fails", async () => {
    fixture.api.mockRejectedValue(new Error("nope"));
    (render().toggle.props.onClick as () => void)();
    await flush();
    expect(render().html).toContain("nope");
  });
});
