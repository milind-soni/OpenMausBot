// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@astryxdesign/core/reset.css?inline", () => ({ default: "" }));
vi.mock("@astryxdesign/core/astryx.css?inline", () => ({ default: "" }));
import { browserMessage, mountBrowserPicker } from "./browser-picker";
import { registerDraft } from "./browser-picker-draft";
let cleanup: (() => void) | undefined;
let unregister: (() => void) | undefined;
afterEach(() => {
  flushSync(() => cleanup?.());
  unregister?.();
  document.body.replaceChildren();
});
it("shows active selection on the toolbar control and Escape exits", async () => {
  const host = document.createElement("omb-browser-picker");
  document.body.append(host);
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  unregister = registerDraft(() => ({
    draftId: "fixture",
    recording: false,
    allowImages: true,
    imageSlots: 1,
    imageBytes: 1000,
    onFiles: vi.fn(),
    onText: vi.fn(),
    getText: () => "",
  }));
  flushSync(() => {
    cleanup = mountBrowserPicker(host, () => ({
      scopeKey: "fixture",
      connected: true,
      control: { controller: "you" },
      surface: () => canvas,
      send: vi.fn(),
      take: vi.fn(),
    }));
  });
  const button = () => host.shadowRoot!.querySelector("button")!;
  expect(button().getAttribute("aria-pressed")).toBe("false");
  flushSync(() => button().click());
  expect(button().getAttribute("aria-pressed")).toBe("true");
  expect(button().getAttribute("title")).toContain("Annotation mode on");
  flushSync(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(button().getAttribute("aria-pressed")).toBe("false");
});
it("adds a captured element to an unsent draft without clicking the webpage", async () => {
  const host = document.createElement("omb-browser-picker");
  document.body.append(host);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 100;
  document.body.append(canvas);
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 100, 100),
  );
  const send = vi.fn();
  const onFiles = vi.fn(async () => {});
  const onText = vi.fn();
  const webpageClick = vi.fn();
  canvas.addEventListener("click", webpageClick);
  unregister = registerDraft(() => ({
    draftId: "fixture",
    recording: false,
    allowImages: true,
    imageSlots: 1,
    imageBytes: 1000,
    onFiles,
    onText,
    getText: () => "existing",
  }));
  flushSync(() => {
    cleanup = mountBrowserPicker(host, () => ({
      scopeKey: "fixture",
      connected: true,
      control: { controller: "you" },
      surface: () => canvas,
      send,
      take: vi.fn(),
    }));
  });
  browserMessage("fixture", { type: "viewport", width: 100, height: 100 });
  flushSync(() =>
    host.shadowRoot!.querySelector<HTMLButtonElement>("button")!.click(),
  );
  flushSync(() =>
    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 10,
        clientY: 10,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(webpageClick).not.toHaveBeenCalled();
  const request = send.mock.calls[0][0];
  expect(request.capture).toBe(true);
  browserMessage("fixture", {
    type: "ombElementInspection",
    requestId: request.requestId,
    image: btoa("png-fixture"),
    element: {
      url: "https://example.com/",
      tag: "h1",
      selector: "h1",
      label: "Heading",
      rect: { x: 0, y: 0, width: 20, height: 20 },
    },
  });
  await vi.waitFor(() => expect(onFiles).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(onText).toHaveBeenCalledWith(
      expect.stringContaining("[Selected browser element]"),
    ),
  );
});

it("can remount the picker on the same toolbar host after effect cleanup", () => {
  const host = document.createElement("omb-browser-picker");
  document.body.append(host);
  const read = () => ({
    scopeKey: "remount",
    connected: true,
    control: { controller: "you" },
    surface: () => null,
    send: vi.fn(),
    take: vi.fn(),
  });
  flushSync(() => {
    cleanup = mountBrowserPicker(host, read);
  });
  flushSync(() => cleanup?.());
  cleanup = undefined;
  expect(() =>
    flushSync(() => {
      cleanup = mountBrowserPicker(host, read);
    }),
  ).not.toThrow();
  expect(host.shadowRoot!.querySelectorAll("button")).toHaveLength(1);
});

it("refreshes the active highlight when the app skin changes", async () => {
  const parent = document.createElement("section"),
    pill = document.createElement("button"),
    host = document.createElement("omb-browser-picker"),
    canvas = document.createElement("canvas");
  pill.dataset.pill = "yours";
  pill.style.backgroundColor = "rgb(1, 2, 3)";
  parent.append(pill, host, canvas);
  document.body.append(parent);
  unregister = registerDraft(() => ({
    draftId: "theme",
    recording: false,
    allowImages: true,
    imageSlots: 1,
    imageBytes: 1000,
    onFiles: vi.fn(),
    onText: vi.fn(),
    getText: () => "",
  }));
  flushSync(() => {
    cleanup = mountBrowserPicker(host, () => ({
      scopeKey: "theme",
      connected: true,
      control: { controller: "you" },
      surface: () => canvas,
      send: vi.fn(),
      take: vi.fn(),
    }));
  });
  flushSync(() =>
    host.shadowRoot!.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(
    host.style.getPropertyValue("--color-browser-selection-background"),
  ).toBe("rgb(1, 2, 3)");
  pill.style.backgroundColor = "rgb(4, 5, 6)";
  document.documentElement.dataset.skin = "daylight";
  await vi.waitFor(() =>
    expect(
      host.style.getPropertyValue("--color-browser-selection-background"),
    ).toBe("rgb(4, 5, 6)"),
  );
  delete document.documentElement.dataset.skin;
});

it.each(["control-loss", "send-refused", "send-threw"])(
  "exits selection after %s instead of staying busy",
  async (mode) => {
    const host = document.createElement("omb-browser-picker"),
      canvas = document.createElement("canvas");
    canvas.width = canvas.height = 100;
    document.body.append(host, canvas);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 100, 100),
    );
    unregister = registerDraft(() => ({
      draftId: "lost-control",
      recording: false,
      allowImages: true,
      imageSlots: 1,
      imageBytes: 1000,
      onFiles: vi.fn(),
      onText: vi.fn(),
      getText: () => "",
    }));
    const send = vi.fn(() => {
      if (mode === "send-threw") throw Error("transport closed");
      return false;
    });
    flushSync(() => {
      cleanup = mountBrowserPicker(host, () => ({
        scopeKey: "lost-control",
        connected: true,
        control: { controller: "you" },
        surface: () => canvas,
        send,
        take: vi.fn(),
      }));
    });
    browserMessage("lost-control", {
      type: "viewport",
      width: 100,
      height: 100,
    });
    flushSync(() =>
      host.shadowRoot!.querySelector<HTMLButtonElement>("button")!.click(),
    );
    expect(
      host.shadowRoot!.querySelector("button")!.getAttribute("aria-pressed"),
    ).toBe("true");
    flushSync(() => {
      if (mode === "control-loss")
        browserMessage("lost-control", {
          type: "ombPickerControl",
          controller: "agent",
        });
      else
        canvas.dispatchEvent(
          new MouseEvent("click", {
            clientX: 10,
            clientY: 10,
            bubbles: true,
            cancelable: true,
          }),
        );
    });
    expect(
      host.shadowRoot!.querySelector("button")!.getAttribute("aria-pressed"),
    ).toBe("false");
    if (mode === "control-loss") expect(send).not.toHaveBeenCalled();
  },
);
