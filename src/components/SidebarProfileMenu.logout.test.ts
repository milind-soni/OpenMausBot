import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";
import type { AccountSession } from "@/lib/use-account-session";

const fixture = vi.hoisted(() => ({
  account: { session: null as AccountSession | null, busy: false, failed: false, onSignOut: vi.fn() },
  items: [] as SidebarMenuItem[],
}));
vi.mock("@/lib/use-account-session", () => ({ useAccountSession: () => fixture.account }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} }, dispatch: vi.fn() }) }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => null }));
vi.mock("./AboutDialog", () => ({ AboutDialog: () => null }));
vi.mock("./ShortcutHint", () => ({ ShortcutHint: () => null }));
vi.mock("./SidebarPopoverMenu", () => ({
  SidebarPopoverMenu: ({ items, footer }: { items: SidebarMenuItem[]; footer: React.ReactNode }) => {
    fixture.items = items;
    return createElement("div", null, items.map((item) => createElement("button", {
      key: item.key, disabled: item.disabled, onClick: item.onSelect,
    }, item.label)), footer);
  },
}));

import { SidebarProfileMenu } from "./SidebarProfileMenu";

beforeEach(() => {
  vi.stubGlobal("window", {});
  fixture.account.session = { kind: "session", email: "member@example.test" };
  fixture.account.busy = false;
  fixture.account.failed = false;
  fixture.account.onSignOut.mockClear();
});

describe("profile menu sign out", () => {
  it("offers a separate trailing sign-out action for a signed-in browser", () => {
    const html = renderToStaticMarkup(createElement(SidebarProfileMenu));
    expect(html).toContain(">Sign out<");
    const item = fixture.items.at(-1)!;
    expect(item).toMatchObject({ key: "sign-out", separatorBefore: true, keepOpen: true, disabled: false });
    item.onSelect();
    expect(fixture.account.onSignOut).toHaveBeenCalledOnce();
  });

  it.each([null, { kind: "loopback" }])("omits sign out when there is no revocable browser session: %j", (session) => {
    fixture.account.session = session;
    expect(renderToStaticMarkup(createElement(SidebarProfileMenu))).not.toContain("Sign out");
    expect(fixture.items.some((item) => item.key === "sign-out")).toBe(false);
  });

  it("disables the action while logout is pending", () => {
    fixture.account.busy = true;
    const html = renderToStaticMarkup(createElement(SidebarProfileMenu));
    expect(html).toContain('disabled="">Signing out…');
  });

  it("keeps an accessible error and an enabled retry action after failure", () => {
    fixture.account.failed = true;
    const html = renderToStaticMarkup(createElement(SidebarProfileMenu));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Sign out did not finish. Try again.");
    expect(fixture.items.at(-1)?.disabled).toBe(false);
  });
});
