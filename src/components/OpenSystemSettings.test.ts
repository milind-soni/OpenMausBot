// @vitest-environment happy-dom
// A refused permission's line comes with the way to the pane that grants it, where the desktop app can open one.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { withOpenSettings } from "./OpenSystemSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { delete window.ogb; });

describe("Open System Settings", () => {
  it("follows the line and opens the pane on this computer", async () => {
    setLocale("en");
    const permOpenSettings = vi.fn(async () => {});
    window.ogb = { permOpenSettings } as unknown as NonNullable<Window["ogb"]>;
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => { root.render(createElement("p", null, withOpenSettings("Dictation needs access.", "speech"))); });
    expect(host.textContent).toBe("Dictation needs access. Open System Settings");
    await act(async () => { host.querySelector("button")!.click(); });
    expect(permOpenSettings).toHaveBeenCalledWith("speech");
    await act(async () => root.unmount());
  });

  it("is left out where no desktop app can open the pane", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => { root.render(createElement("p", null, withOpenSettings("The microphone is blocked.", "mic"))); });
    expect(host.querySelector("button")).toBeNull();
    await act(async () => root.unmount());
  });
});
