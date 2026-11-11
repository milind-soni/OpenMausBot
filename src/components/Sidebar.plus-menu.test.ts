// @vitest-environment happy-dom
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, admin: true as boolean | null, team: false }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: () => {},
  useLayoutEffect: () => {},
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("./MenuMotion", () => ({
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
  useHeldMenuMotion: (value: unknown) => ({ shown: value !== null, value, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities() }), windowFramed: () => false };
});
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: () => {} }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.team ? { ...original.initialState, config: { team: { id: "acme", name: "Acme" } } } : original.initialState, dispatch: vi.fn() }) };
});

import { Sidebar } from "./Sidebar";

type Props = { children?: ReactNode; onClick?: () => void; role?: string; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...nodes(child.props.children)];
  });
}
function words(value: ReactNode): string {
  return Children.toArray(value).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement<Props>(child) ? words(child.props.children) : "";
  }).join("");
}
function render() {
  fixture.index = 0;
  return nodes(Sidebar({ open: true, onClose: () => {} }));
}
function plusMenu(admin: boolean | null, team = false) {
  fixture.values = [];
  fixture.admin = admin;
  fixture.team = team;
  render().find((node) => node.type === "button" && String(node.props["aria-label"]).startsWith("New"))!.props.onClick!();
  return render().filter((node) => node.props.role === "menuitem").map((node) => words(node.props.children));
}

describe("the sidebar's + menu", () => {
  it("offers a new bot and templates to someone who can make one, and while that isn't known yet", () => {
    for (const admin of [true, null]) expect(plusMenu(admin)).toEqual(["New bot", "New group chat", "Templates"]);
  });

  it("offers a team's User a new bot of their own, and templates only to its admins", () => {
    expect(plusMenu(false, true)).toEqual(["New bot", "New group chat"]);
    expect(plusMenu(true, true)).toEqual(["New bot", "New group chat", "Templates"]);
  });

  it("offers neither to someone without the admin scope anywhere else, who keeps New group chat", () => {
    expect(plusMenu(false)).toEqual(["New group chat"]);
  });
});
