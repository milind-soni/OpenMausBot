import { describe, expect, it } from "vitest";
import { schedulePlace } from "./RoutineScheduleNote";

describe("where a routine runs, said where it is scheduled", () => {
  const free = { kind: "free" } as const, paid = { kind: "paid", label: "Pro", checking: false } as const;
  it("My Cloud runs it 24/7; another server, a browser or companion mode while that server runs", () => {
    expect(schedulePlace({ cloudHome: true, local: false, plan: null, ready: false, offersAllowed: true })).toEqual({ kind: "cloud" });
    expect(schedulePlace({ cloudHome: false, local: false, plan: free, ready: false, offersAllowed: true })).toEqual({ kind: "server" });
  });
  it("This computer: Add a Cloud for someone who may buy where it is offered, Open My Cloud once it is ready, else the note alone", () => {
    expect(schedulePlace({ cloudHome: false, local: true, plan: free, ready: false, offersAllowed: true })).toEqual({ kind: "local", next: "add-cloud" });
    expect(schedulePlace({ cloudHome: false, local: true, plan: { kind: "signed-out" }, ready: false, offersAllowed: true })).toEqual({ kind: "local", next: "add-cloud" });
    expect(schedulePlace({ cloudHome: false, local: true, plan: free, ready: false, offersAllowed: false })).toEqual({ kind: "local", next: null });
    expect(schedulePlace({ cloudHome: false, local: true, plan: paid, ready: true, offersAllowed: true })).toEqual({ kind: "local", next: "open-cloud" });
    expect(schedulePlace({ cloudHome: false, local: true, plan: paid, ready: false, offersAllowed: true })).toEqual({ kind: "local", next: null });
    for (const plan of [{ kind: "attention", label: "Pro" }, { kind: "unknown" }, { kind: "reauth", label: "Pro", reason: "expired" }] as const) {
      expect(schedulePlace({ cloudHome: false, local: true, plan, ready: false, offersAllowed: true })).toEqual({ kind: "local", next: null });
    }
    expect(schedulePlace({ cloudHome: false, local: true, plan: null, ready: false, offersAllowed: true })).toEqual({ kind: "local", next: null });
  });
});

describe("the note's way to My Cloud", () => {
  it("says it in plain words with Open My Cloud as the link, and asks before leaving the routine being edited", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { vi } = await import("vitest");
    vi.resetModules();
    const connectHome = vi.fn(async () => ({}));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { ogb: { cloudAccount: { connectHome } }, confirm });
    vi.doMock("@/state/store", () => ({ useStore: () => ({ state: { config: { cloudHome: false } }, dispatch: vi.fn() }) }));
    vi.doMock("./ProIntroduction", () => ({ useCloudPlan: () => ({ view: { kind: "paid", label: "Pro", checking: false }, account: { machine: { status: "ready" } } }) }));
    vi.doMock("./onboarding/WelcomeGate", () => ({ localDesktopPage: () => true }));
    vi.doMock("@/lib/brand", () => ({ brandStatus: () => ({ source: "default" }) }));
    const { RoutineScheduleNote } = await import("./RoutineScheduleNote");
    const html = renderToStaticMarkup(createElement(RoutineScheduleNote));
    expect(html.replace(/<[^>]+>/g, "")).toContain("To run routines 24/7, create them on My Cloud. Open My Cloud");
    // The sentence itself is no link; only "Open My Cloud" is.
    expect(html.match(/<button[^>]*>([^<]*)<\/button>/)?.[1]).toBe("Open My Cloud");
    const tree = RoutineScheduleNote() as { props: { children: unknown } };
    const find = (node: unknown): { props: { onClick(): void } } | undefined => {
      if (!node || typeof node !== "object") return undefined;
      if (Array.isArray(node)) return node.map(find).find(Boolean);
      const element = node as { type?: unknown; props?: { children?: unknown; onClick?: () => void } };
      if (element.type === "button") return element as { props: { onClick(): void } };
      return find(element.props?.children);
    };
    find(tree)!.props.onClick();
    expect(confirm).toHaveBeenCalledWith("Open My Cloud? This routine isn't saved, so it closes without saving.");
    expect(connectHome).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    find(tree)!.props.onClick();
    expect(connectHome).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
    vi.doUnmock("@/state/store"); vi.doUnmock("./ProIntroduction"); vi.doUnmock("./onboarding/WelcomeGate"); vi.doUnmock("@/lib/brand");
  });
});
