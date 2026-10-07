import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: { status: "idle" } as UpdaterState }));
// As the real hook: no state without the desktop app's updater bridge.
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => (window.ogb?.updater ? fixture.state : null) }));
vi.mock("../lib/brand", () => ({ brand: () => ({ name: "OpenMausBot" }) }));
import { UpdateBanner } from "./UpdateBanner";

afterEach(() => vi.unstubAllGlobals());
function render(state: UpdaterState, window: object = { ogb: { updater: {} } }) {
  fixture.state = state;
  vi.stubGlobal("window", window);
  return renderToStaticMarkup(createElement(UpdateBanner));
}

const LOCAL = "http://127.0.0.1:8799";
const CLOUD = "https://home-7f3k2.fly.dev";
const OTHER = "https://bots.example.test";
/** The window.ogb that electron/preload.cjs gives a server's page; `answered`:
 * whether main answers that page about updates (My Cloud's, not another's). */
function serverPageBridge(origin: string, answered: boolean) {
  let bridge: unknown;
  vm.runInNewContext(readFileSync(new URL("../../electron/preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`] },
    location: { origin }, navigator: { userActivation: { isActive: false } },
    TextEncoder, localStorage: { getItem: () => null },
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { bridge = value; } },
      ipcRenderer: {
        on() {}, removeListener() {}, send() {}, invoke: () => Promise.resolve({ status: "idle" }),
        sendSync: (channel: string) => channel === "update:offered" && answered,
      },
    }),
  });
  return bridge;
}

describe("UpdateBanner", () => {
  it("shows the ready update and its restart on My Cloud's page", () => {
    const html = render({ status: "downloaded", version: "0.2.0" }, { location: { origin: CLOUD }, ogb: serverPageBridge(CLOUD, true) });
    expect(html).toContain("OpenMausBot 0.2.0 is ready");
    expect(html).toContain("Restart to update");
    expect(html).toContain("Later");
  });

  it("is absent from another server's page, which never gets the updater", () => {
    const ogb = serverPageBridge(OTHER, false) as { updater?: unknown };
    expect(ogb.updater).toBeUndefined();
    expect(render({ status: "downloaded", version: "0.2.0" }, { location: { origin: OTHER }, ogb })).toBe("");
  });

  // Updates download by themselves: nothing to do yet, so nothing to show.
  it.each([
    { status: "downloading", version: "0.2.0" },
    { status: "downloading", version: "0.2.0", percent: 40 },
    { status: "preparing", version: "0.2.0", percent: 100 },
  ] as UpdaterState[])("stays quiet while an update downloads by itself: %o", (state) => {
    expect(render(state)).toBe("");
  });

  it("offers restart only after native preparation is complete", () => {
    const html = render({ status: "downloaded", version: "0.2.0" });
    expect(html).toContain("0.2.0 is ready");
    expect(html).toContain("Restart to update");
  });

  it("keeps restart busy and displays the recovery instruction", () => {
    const html = render({ status: "installing", message: "Restart is taking longer than expected. Quit the app completely." });
    expect(html).toContain("Quit the app completely.");
    expect(html).toContain("disabled=\"\"");
    expect(html).not.toContain("Try again");
  });

  it("shows a preparation failure with a recovery action", () => {
    const html = render({ status: "error", message: "Native staging failed" });
    expect(html).toContain("Update failed");
    expect(html).toContain("Native staging failed");
    expect(html).toContain("Try again");
  });

  it.each(["ETIMEDOUT while staging", "native error ".repeat(30)])("preserves restart recovery for a nonretryable error: %s", (message) => {
    const html = render({ status: "error", retryable: false, message });
    expect(html).toContain("Quit and reopen OpenMausBot before trying the update again.");
    expect(html).not.toContain("Try again");
    expect(html).toContain("Dismiss");
  });

  it("preserves system package hand-off without promising restart", () => {
    const html = render({ status: "downloaded", version: "0.2.0", installMode: "handoff" });
    expect(html).toContain("Copy the install command and open a terminal.");
    expect(html).not.toContain("Restart to update");
  });

  it("shows the failure cause as well as the required restart without offering a retry", () => {
    const html = render({ status: "error", retryable: false,
      message: "Not enough disk space to prepare the update. Free some space, then try again. Quit and reopen OpenMausBot before trying the update again.",
    });
    expect(html).toContain("Free some space");
    expect(html).toContain("Quit and reopen OpenMausBot");
    expect(html).not.toContain("Try again</button>");
  });
});
