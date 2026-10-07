import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

// The desktop app answers only this computer's page and the person's own
// Cloud (on My Cloud, only once the saved sign-in has been restored). Until it
// answers, the profile menu has no update entry to offer.
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
  // Named: on My Cloud's page it is this app that restarts, not the Cloud.
  expect(ready?.label).toBe("OpenMausBot 0.2.0 ready — restart");
  expect(ready?.item.attention).toBe(true);
});
