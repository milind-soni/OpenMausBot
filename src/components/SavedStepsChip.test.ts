import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { SavedStepsChip } from "./SavedStepsChip";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, api: vi.fn(), ownerOrAdmin: true as boolean | null }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
}));
vi.mock("@/state/store", () => ({ api: fixture.api }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (value: ReactNode): Node[] => Children.toArray(value).flatMap((child) => (isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []));

const REPLY = { id: "m1", role: "bot", kind: "text", at: 1, text: "Done." } as Message;
const LEARNED = { ...REPLY, savedSteps: { recipeId: "r1", learned: true } } as Message;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(message: Message) {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = SavedStepsChip({ botId: "b1", message }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  return { html, forget: all.find((node) => node.props["data-saved-steps-forget"] !== undefined), alert: all.find((node) => node.props.role === "alert") };
}

beforeEach(() => { fixture.values = []; fixture.ownerOrAdmin = true; fixture.api.mockReset().mockResolvedValue({ ok: true }); });

describe("the saved-steps chip under a reply", () => {
  it("says the steps were saved", () => expect(render(LEARNED).html).toContain("Saved these steps · next time no AI"));
  it("says a reply came from saved steps", () => expect(render({ ...REPLY, savedSteps: { recipeId: "r1", replayed: true } } as Message).html).toContain("Repeated saved steps · no AI"));
  it("draws nothing on other replies", () => expect(render(REPLY).html).toBe(""));

  it.each<[string, boolean | null]>([["a person with the User role", false], ["someone whose role is not known yet", null]])(
    "offers Forget only to the owner and admins, not to %s", (_, ownerOrAdmin) => {
      fixture.ownerOrAdmin = ownerOrAdmin;
      const view = render(LEARNED);
      expect(view.html).toContain("Saved these steps · next time no AI");
      expect(view.html).not.toContain("Forget");
      expect(view.forget).toBeUndefined();
    },
  );

  it("Forget deletes the recipe and says so", async () => {
    const view = render(LEARNED);
    (view.forget!.props.onClick as () => void)();
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1/saved-steps/r1", { method: "DELETE" });
    await flush();
    const after = render(LEARNED);
    expect(after.html).toContain("Forgotten");
    expect(after.forget).toBeUndefined();
  });

  it("ignores a second press while the request is in flight", () => {
    fixture.api.mockReturnValue(new Promise(() => {}));
    const view = render(LEARNED);
    (view.forget!.props.onClick as () => void)();
    (view.forget!.props.onClick as () => void)();
    expect(fixture.api).toHaveBeenCalledTimes(1);
  });

  it("shows the failure and keeps Forget", async () => {
    fixture.api.mockRejectedValue(new Error("boom"));
    (render(LEARNED).forget!.props.onClick as () => void)();
    await flush();
    const after = render(LEARNED);
    expect(after.alert!.props.children).toContain("Couldn't forget these steps. Try again.");
    expect(after.forget).toBeDefined();
  });
});
