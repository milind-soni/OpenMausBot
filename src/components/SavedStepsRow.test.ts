import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SavedStepsRow } from "./SavedStepsRow";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, api: vi.fn(), dispatch: vi.fn(), config: {} as unknown }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
}));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }) }));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (value: ReactNode): Node[] => Children.toArray(value).flatMap((child) => (isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function render() {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = SavedStepsRow(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, toggle: nodes(tree).find((node) => node.props.role === "switch" || node.props["aria-label"] === "Repeat computer tasks without AI"), tree };
}

const HERE = { savedStepsHere: true };
beforeEach(() => { fixture.values = []; fixture.config = { features: HERE }; fixture.api.mockReset(); fixture.dispatch.mockReset(); });

describe("the saved-steps setting", () => {
  it("is on when the config does not mention it, and titled in plain words", () => {
    const view = render();
    expect(view.html).toContain("Repeat computer tasks without AI");
    expect(view.html).toContain('aria-checked="true"');
  });

  it("draws nothing where the server cannot run saved steps (Windows, a Cloud home) or does not say", () => {
    fixture.config = { features: { savedStepsHere: false } };
    expect(render().html).toBe("");
    fixture.config = {};
    expect(render().html).toBe("");
  });

  it("shows off when the config turns it off", () => {
    fixture.config = { features: { ...HERE, savedSteps: false } };
    expect(render().html).toContain('aria-checked="false"');
  });

  it("the switch saves the opposite value", async () => {
    const config = { features: { ...HERE, savedSteps: false } };
    fixture.api.mockResolvedValue(config);
    (render().toggle!.props.onClick as () => void)();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { savedSteps: false } }) });
    await flush();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config });
  });

  it("shows a short error when saving fails", async () => {
    fixture.api.mockRejectedValue("nope");
    (render().toggle!.props.onClick as () => void)();
    await flush();
    expect(render().html).toContain("Couldn&#x27;t change this setting. Try again.");
  });
});
