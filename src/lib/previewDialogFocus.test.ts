import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FOCUSABLE_SELECTOR,
  resolveDialogInvoker,
  restoreDialogFocus,
  trapDialogFocus,
} from "./dialogFocus";
import { PreviewFilePicker } from "@/components/PreviewFilePicker";
import { SharePreviewModal } from "@/components/SharePreviewModal";
import { StoreProvider } from "@/state/store";

interface MockElement {
  nodeName: string;
  focus: () => void;
  isConnected: boolean;
  querySelectorAll?: (selector: string) => MockElement[];
  contains?: (el: MockElement | null) => boolean;
}

function createMockElement(nodeName = "BUTTON"): MockElement & HTMLElement {
  const el: Partial<MockElement & HTMLElement> = {
    nodeName,
    focus: vi.fn(),
    isConnected: true,
  };
  return el as MockElement & HTMLElement;
}

describe("Preview dialog focus management & return (abe7fe48 regression)", () => {
  it("never includes JSX autofocus in PreviewFilePicker markup (prevents premature activeElement hijack)", () => {
    const html = renderToStaticMarkup(
      createElement(PreviewFilePicker, {
        open: true,
        onClose: () => {},
        onSelectFile: () => {},
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('placeholder="Search HTML, PDF, Markdown, text or image files…"');
    expect(html).not.toMatch(/<input[^>]*\bautofocus\b/i);
  });

  it("never includes JSX autofocus in SharePreviewModal markup (prevents premature activeElement hijack)", () => {
    const html = renderToStaticMarkup(
      createElement(
        StoreProvider,
        null,
        createElement(SharePreviewModal, {
          open: true,
          onClose: () => {},
          currentSizeLabel: "Laptop",
          currentDimensionsLabel: "1280 × 800",
          selectedSizesCount: 1,
          onSubmit: async () => {},
        }),
      ),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('id="share-preview-target"');
    expect(html).not.toMatch(/<select[^>]*\bautofocus\b/i);
  });

  it("resolves invoker from explicit triggerRef ref object", () => {
    const trigger = createMockElement("BUTTON");
    const triggerRef = { current: trigger };
    const invoker = resolveDialogInvoker(triggerRef, null);
    expect(invoker).toBe(trigger);
  });

  it("resolves invoker from explicit direct trigger element", () => {
    const trigger = createMockElement("BUTTON");
    const invoker = resolveDialogInvoker(trigger, null);
    expect(invoker).toBe(trigger);
  });

  it("falls back to document activeElement when triggerRef is omitted", () => {
    const trigger = createMockElement("BUTTON");
    const invoker = resolveDialogInvoker(undefined, trigger);
    expect(invoker).toBe(trigger);
  });

  it("never records document.body as the invoker", () => {
    const body = createMockElement("BODY");
    vi.stubGlobal("document", { body });
    const invoker = resolveDialogInvoker(undefined, body);
    expect(invoker).toBeNull();
  });

  it("restores focus to connected trigger element on close", () => {
    const trigger = createMockElement("BUTTON");
    const result = restoreDialogFocus(trigger);
    expect(result).toBe(true);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
  });

  it("skips focus restoration if trigger element is disconnected", () => {
    const trigger = createMockElement("BUTTON");
    trigger.isConnected = false;
    const result = restoreDialogFocus(trigger);
    expect(result).toBe(false);
    expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("schedules a frame retry if DOM detachment resets activeElement to body", () => {
    let rafCallback: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallback = cb;
      return 1;
    });

    const trigger = createMockElement("BUTTON");
    const body = createMockElement("BODY");
    vi.stubGlobal("document", { body, activeElement: body });

    restoreDialogFocus(trigger);
    expect(trigger.focus).toHaveBeenCalledTimes(1);

    // Simulate browser microtask resetting activeElement to body after modal unmount
    if (rafCallback) {
      (rafCallback as (time: number) => void)(0);
    }
    expect(trigger.focus).toHaveBeenCalledTimes(2);
  });

  it("traps Tab key within dialog container at boundaries", () => {
    const first = createMockElement("INPUT");
    const last = createMockElement("BUTTON");
    const container = createMockElement("DIV");
    container.querySelectorAll = ((() => [first, last]) as unknown) as typeof container.querySelectorAll;
    container.contains = (el) => el === first || el === last;

    // Forward Tab from last wraps to first
    vi.stubGlobal("document", { activeElement: last });
    const forwardEvent = {
      key: "Tab",
      shiftKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    const trappedForward = trapDialogFocus(forwardEvent, container, DEFAULT_FOCUSABLE_SELECTOR);
    expect(trappedForward).toBe(true);
    expect(forwardEvent.preventDefault).toHaveBeenCalled();
    expect(first.focus).toHaveBeenCalled();

    // Shift+Tab from first wraps to last
    vi.stubGlobal("document", { activeElement: first });
    const reverseEvent = {
      key: "Tab",
      shiftKey: true,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    const trappedReverse = trapDialogFocus(reverseEvent, container, DEFAULT_FOCUSABLE_SELECTOR);
    expect(trappedReverse).toBe(true);
    expect(reverseEvent.preventDefault).toHaveBeenCalled();
    expect(last.focus).toHaveBeenCalled();
  });
});
