import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: { status: "idle" } as UpdaterState }));
// As the real hook: no state without the desktop app's updater bridge.
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => (window.ogb?.updater ? fixture.state : null) }));
vi.mock("../lib/brand", () => ({ brand: () => ({ name: "OpenMausBot" }), productName: () => "MausBot" }));
import { UpdateBanner } from "./UpdateBanner";

afterEach(() => vi.unstubAllGlobals());
function render(state: UpdaterState, window: object = { ogb: { updater: {} } }, sidebarIndicator = false) {
  fixture.state = state;
  vi.stubGlobal("window", window);
  return renderToStaticMarkup(createElement(UpdateBanner, { sidebarIndicator }));
}

const LOCAL = "http://127.0.0.1:8799";
const CLOUD = "https://home-7f3k2.fly.dev";
const OTHER = "https://bots.example.test";
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
    expect(html).toContain("MausBot 0.2.0 is ready");
    expect(html).toContain("Restart to update");
    expect(html).toContain("Later");
  });

  it("is absent from another server's page, which never gets the updater", () => {
    const ogb = serverPageBridge(OTHER, false) as { updater?: unknown };
    expect(ogb.updater).toBeUndefined();
    expect(render({ status: "downloaded", version: "0.2.0" }, { location: { origin: OTHER }, ogb })).toBe("");
  });

  it.each([
    { status: "downloading", version: "0.2.0" },
    { status: "downloading", version: "0.2.0", percent: 40 },
    { status: "preparing", version: "0.2.0", percent: 100 },
  ] as UpdaterState[])("stays quiet while an update downloads by itself: %o", (state) => {
    expect(render(state)).toBe("");
  });

  it("says a ready update installs by itself the next time the person is away, beside its Restart", () => {
    const html = render({ status: "downloaded", version: "0.2.0", installsByItself: true });
    expect(html).toContain("MausBot installs it by itself the next time you");
    expect(html).toContain("Restart to update");
    expect(render({ status: "downloaded", version: "0.2.0", installMode: "handoff", installsByItself: true })).not.toContain("by itself");
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
    expect(html).toContain("Quit and reopen MausBot before trying the update again.");
    expect(html).not.toContain("Try again");
    expect(html).toContain("Dismiss");
  });

  it("preserves system package hand-off without promising restart", () => {
    const html = render({ status: "downloaded", version: "0.2.0", installMode: "handoff" });
    expect(html).toContain("Copy the install command and open a terminal.");
    expect(html).not.toContain("Restart to update");
  });

  it("says why the automatic install did not run before the hand-off steps", () => {
    const html = render({
      status: "handed-off", version: "0.2.0", installMode: "restart", terminalOpened: true,
      message: "This session could not ask for administrator rights.",
      command: "sudo apt-get install -y '/tmp/x.deb'",
    });
    expect(html).toContain("This session could not ask for administrator rights.");
    expect(html).toContain("paste it in the terminal that opened");
    // a plain hand-off has nothing extra to explain
    expect(render({ status: "handed-off", version: "0.2.0", installMode: "handoff", terminalOpened: true, command: "x" }))
      .toContain("Command copied");
  });

  it("a .deb that installs itself offers the restart, with the password step explained while it runs", () => {
    const ready = render({ status: "downloaded", version: "0.2.0", installMode: "restart" });
    expect(ready).toContain("Restart to update");
    expect(ready).not.toContain("terminal");
    const running = render({ status: "installing", version: "0.2.0", installMode: "restart", message: "Installing the update. Enter your password if asked." });
    expect(running).toContain("Enter your password if asked.");
  });

  it("shows the failure cause as well as the required restart without offering a retry", () => {
    const html = render({ status: "error", retryable: false,
      message: "Not enough disk space to prepare the update. Free some space, then try again. Quit and reopen OpenMausBot before trying the update again.",
    });
    expect(html).toContain("Free some space");
    expect(html).toContain("Quit and reopen MausBot");
    expect(html).not.toContain("Try again</button>");
  });

  it("leaves the ready update to the sidebar's update button while the sidebar is in view", () => {
    expect(render({ status: "downloaded", version: "1.2.3", installMode: "restart" }, undefined, true)).toBe("");
    expect(render({ status: "installing", version: "1.2.3" }, undefined, true)).toBe("");
    expect(render({ status: "downloaded", version: "1.2.3", installMode: "restart" }, undefined, false)).toContain("Restart");
    expect(render({ status: "handed-off", version: "1.2.3", installMode: "handoff", command: "sudo apt install ./x.deb" }, undefined, true)).toContain("Finish in a terminal");
    expect(render({ status: "error", message: "boom" }, undefined, true)).toContain("Update failed");
  });
});
