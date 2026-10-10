import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ update: { status: "idle" } as UpdaterState }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} }, dispatch: vi.fn() }) }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.update }));
vi.mock("./SidebarPhoneButton", () => ({ useSidebarPhoneStatus: () => ({ kind: "unavailable" }) }));

import { SidebarProfileMenu } from "./SidebarProfileMenu";

beforeEach(() => { vi.stubGlobal("window", { ogb: { updater: {} } }); });
afterEach(() => { vi.unstubAllGlobals(); });

it.each([false, true])("keeps update progress on the separate button, iconOnly=%s", (iconOnly) => {
  for (const status of ["idle", "checking", "downloading", "preparing", "downloaded", "installing"] as const) {
    fixture.update = { status };
    const html = renderToStaticMarkup(createElement<{ iconOnly: boolean }>(SidebarProfileMenu, { iconOnly }));
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toMatch(/bg-(accent|danger)\//);
    expect(html).not.toContain("ring-2 ring-app");
  }
});

it.each([false, true])("retains error attention when no separate update button is shown, iconOnly=%s", (iconOnly) => {
  fixture.update = { status: "error", message: "Fixture update failed" };
  const html = renderToStaticMarkup(createElement<{ iconOnly: boolean }>(SidebarProfileMenu, { iconOnly }));
  expect(html).toContain("bg-danger");
  if (!iconOnly) expect(html).toContain('aria-label="Fixture update failed"');
});
