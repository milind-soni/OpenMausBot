import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { HelperKeySuggestion } from "./HelperKeySuggestion";
import { richRowKind } from "./RichMessageRow";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, api: vi.fn(), dispatch: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
}));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: {}, dispatch: fixture.dispatch }) }));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (value: ReactNode): Node[] => Children.toArray(value).flatMap((child) => (isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []));
const message = (answer?: "notNow"): Message => ({
  id: "m1", role: "bot", kind: "text", at: 0, text: "Want me to sort your email for free?", setupSuggestion: { kind: "helperKey", ...(answer ? { answer } : {}) },
} as Message);
function render(of: Message) {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = HelperKeySuggestion({ threadId: "t1", message: of }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  return { html, add: all.find((node) => node.props["data-testid"] === "helper-suggestion-add"), notNow: all.find((node) => node.props["data-testid"] === "helper-suggestion-not-now") };
}

beforeEach(() => {
  fixture.values = [];
  fixture.api.mockReset().mockResolvedValue({ ok: true });
  fixture.dispatch.mockReset();
});

describe("the add-a-key suggestion card", () => {
  it("is a plain message with Add key and Not now, in the device's words, not an approval card", () => {
    const view = render(message());
    expect(view.html).toContain("Want me to sort your email for free? Add a Cloudflare Workers AI key (free tier) or a Jev key.");
    expect(view.html).toContain("Add key");
    expect(view.html).toContain("Not now");
    expect(view.html).not.toContain("data-ask-card");
    expect(richRowKind(message())).toBe("widget");
  });

  it("Add key opens Settings → Decision and extraction on this device; nothing is sent", () => {
    (render(message()).add!.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "decisionModel" });
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("Not now is sent once, and once answered the card says so with no buttons", async () => {
    (render(message()).notNow!.props.onClick as () => void)();
    await Promise.resolve();
    expect(fixture.api).toHaveBeenCalledWith("/api/helpers/suggestion/not-now", { method: "POST", body: JSON.stringify({ threadId: "t1", messageId: "m1" }) });
    const answered = render(message("notNow"));
    expect(answered.html).toContain("Okay, I won&#x27;t ask again.");
    expect(answered.add).toBeUndefined();
    expect(answered.notNow).toBeUndefined();
  });
});
