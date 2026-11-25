// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenInBrowserButton } from "./HtmlFilePreview";

describe("OpenInBrowserButton click (#4406)", () => {
  afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });
  const click = (openHtmlInBrowser: (source: string, name: string) => Promise<unknown>, onError: (reason: string) => void) => {
    vi.stubGlobal("ogb", { openHtmlInBrowser });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    flushSync(() => root.render(createElement(OpenInBrowserButton, { source: "<p>hi</p>", name: "report.html", onError })));
    flushSync(() => host.querySelector("button")?.click());
    return root;
  };

  it("hands the page and its name to the desktop app", () => {
    const open = vi.fn(async () => true), onError = vi.fn();
    click(open, onError).unmount();
    expect(open).toHaveBeenCalledExactlyOnceWith("<p>hi</p>", "report.html");
    expect(onError).toHaveBeenCalledExactlyOnceWith("");
  });

  it("shows why the desktop app could not open it", async () => {
    const onError = vi.fn();
    click(async () => { throw new Error("No application is set to open .html files"); }, onError).unmount();
    await expect.poll(() => onError.mock.calls.at(-1)?.[0]).toBe("No application is set to open .html files");
  });
});
