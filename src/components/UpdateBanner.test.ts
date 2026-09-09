import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: { status: "idle" } as UpdaterState }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.state }));
vi.mock("../lib/brand", () => ({ brand: () => ({ name: "OpenMausBot" }) }));
import { UpdateBanner } from "./UpdateBanner";

afterEach(() => vi.unstubAllGlobals());
function render(state: UpdaterState) {
  fixture.state = state;
  vi.stubGlobal("window", { ogb: { updater: {} } });
  return renderToStaticMarkup(createElement(UpdateBanner));
}

describe("UpdateBanner", () => {
  it("cannot restart or retry while macOS is preparing the downloaded bytes", () => {
    const html = render({ status: "preparing", version: "0.2.0", percent: 100 });
    expect(html).toContain("Preparing update…");
    expect(html).toContain("macOS is preparing the update.");
    expect(html).toContain("disabled=\"\"");
    expect(html).not.toContain("Restart to update");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("Dismiss");
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
});
