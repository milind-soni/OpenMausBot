import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: null as UpdaterState | null }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.state }));
import { useUpdateItem } from "./SidebarProfileMenu";

afterEach(() => vi.unstubAllGlobals());
function entry(state: UpdaterState | null) {
  fixture.state = state;
  vi.stubGlobal("window", { ogb: { updater: { check: vi.fn(), install: vi.fn(), onState: vi.fn() } } });
  let result: ReturnType<typeof useUpdateItem> = null;
  renderToStaticMarkup(createElement(() => { result = useUpdateItem(); return null; }));
  return result as ReturnType<typeof useUpdateItem>;
}

it("offers no update entry on a page the desktop app doesn't answer, such as another server's", () => {
  expect(entry(null)).toBeNull();
});

it("offers the restart once an update has downloaded by itself", () => {
  expect(entry({ status: "idle" })?.label).toBe("Check for updates");
  const ready = entry({ status: "downloaded", version: "0.2.0" });
  expect(ready?.label).toBe("Restart to update to MausBot 0.2.0");
  expect(ready?.item.attention).toBe(true);
});
