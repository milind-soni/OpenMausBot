import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

// The desktop app answers only this computer's page and the person's own
// Cloud (on My Cloud, only once the saved sign-in has been restored). Until it
// answers, Settings says nothing about this app's updates.
const fixture = vi.hoisted(() => ({ state: null as UpdaterState | null }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.state }));
import { UpdatesRow } from "./SettingsModal";

afterEach(() => vi.unstubAllGlobals());
function render(state: UpdaterState | null) {
  fixture.state = state;
  vi.stubGlobal("window", { ogb: { updater: { check: vi.fn(), install: vi.fn(), onState: vi.fn() } } });
  return renderToStaticMarkup(createElement(UpdatesRow));
}

it("says nothing about updates on a page the desktop app doesn't answer, such as another server's", () => {
  expect(render(null)).toBe("");
});

it("shows this app's update where the desktop app answers, with no Download step", () => {
  expect(render({ status: "idle" })).toContain("Check for updates");
  const downloading = render({ status: "downloading", version: "0.2.0", percent: 40 });
  expect(downloading).toContain("Downloading 40%");
  expect(downloading).toContain("disabled");
  // Named: on My Cloud's Settings it is this app that restarts, not the Cloud.
  const ready = render({ status: "downloaded", version: "0.2.0" });
  expect(ready).toContain("OpenMausBot 0.2.0 is ready — restart the app to apply");
  expect(ready).toContain("Restart and install");
  expect(render({ status: "downloaded", version: "0.2.0", installMode: "handoff" })).toContain("OpenMausBot 0.2.0 is ready — install it in a terminal");
});
