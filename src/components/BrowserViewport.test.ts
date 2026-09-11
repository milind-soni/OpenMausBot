import { Children, createElement, type EffectCallback, type ImgHTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactElement, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrowserViewport, browserViewportPoint, createBrowserPressedInputs } from "./BrowserViewport";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[] }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); } };
});

const key = (eventType: string, value = "a", modifiers = 0) => ({
  type: "input_keyboard", eventType, key: value, code: value === "Shift" ? "ShiftLeft" : "KeyA", modifiers,
  ...(eventType === "keyDown" && value.length === 1 ? { text: value } : {}),
});

function viewport(driving = true, metadata?: { deviceWidth: number; deviceHeight: number }) {
  fixture.effects = [];
  const input = vi.fn();
  const onReturnToToolbar = vi.fn();
  let image!: ReactElement<ImgHTMLAttributes<HTMLImageElement>>;
  function Capture() {
    const tree = BrowserViewport({ frame: { seq: 1, data: "fixture", metadata }, width: 1280, height: 720,
      driving, input, acknowledge: vi.fn(), onDecodeError: vi.fn(), onReturnToToolbar });
    image = Children.only(tree.props.children) as typeof image;
    return tree;
  }
  renderToStaticMarkup(createElement(Capture));
  const screen = { complete: true, naturalWidth: 1280, naturalHeight: 720, currentSrc: image.props.src,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    addEventListener: vi.fn((_name: string, _listener: (event: WheelEvent) => void, _options: AddEventListenerOptions) => {}),
    removeEventListener: vi.fn(),
    hasPointerCapture: vi.fn(() => false), focus: vi.fn(), setPointerCapture: vi.fn() };
  (image.props as typeof image.props & { ref: RefObject<unknown> }).ref.current = screen;
  return { input, onReturnToToolbar, props: image.props, screen, effects: fixture.effects };
}

describe("browser frame coordinate mapping", () => {
  const rect = { left: 10, top: 20, width: 600, height: 600 };
  it("maps the letterboxed frame centre using the displayed frame, not later status dimensions", () => {
    expect(browserViewportPoint(rect, 1280, 720, 1280, 720, 310, 320)).toEqual({ x: 640, y: 360 });
    expect(browserViewportPoint(rect, 800, 600, 800, 600, 310, 320)).toEqual({ x: 400, y: 300 });
  });
  it("ignores letterboxing and zero-sized layouts but clamps captured drags", () => {
    expect(browserViewportPoint(rect, 1280, 720, 1280, 720, 310, 25)).toBeNull();
    expect(browserViewportPoint({ ...rect, width: 0 }, 1280, 720, 1280, 720, 310, 320)).toBeNull();
    expect(browserViewportPoint(rect, 1280, 720, 1280, 720, 310, 25, true)).toEqual({ x: 640, y: 0 });
  });
  it("maps a scaled screenshot to CSS pixels, including a tall image in a wide pane", () => {
    expect(browserViewportPoint({ left: 0, top: 0, width: 1200, height: 400 }, 800, 1600, 400, 800, 600, 200)).toEqual({ x: 200, y: 400 });
    expect(browserViewportPoint({ left: 0, top: 0, width: 1200, height: 400 }, 800, 1600, 400, 800, 100, 200)).toBeNull();
  });
});

describe("browser viewport input forwarding", () => {
  it("forwards Escape down and up to the remote page without blurring it", () => {
    const { input, onReturnToToolbar, props } = viewport();
    const blur = vi.fn();
    const preventDefault = vi.fn();
    const event = { key: "Escape", code: "Escape", keyCode: 27, altKey: false, ctrlKey: false,
      metaKey: false, shiftKey: false, nativeEvent: { isComposing: false }, currentTarget: { blur }, preventDefault } as unknown as KeyboardEvent<HTMLImageElement>;
    props.onKeyDown!(event); props.onKeyUp!(event);
    expect(input.mock.calls.map(([body]) => body)).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, modifiers: 0 },
      { type: "input_keyboard", eventType: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, modifiers: 0 },
    ]);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(blur).not.toHaveBeenCalled();
    expect(onReturnToToolbar).not.toHaveBeenCalled();
  });

  it("releases held input before Shift+Escape returns focus to the toolbar", () => {
    const { input, onReturnToToolbar, props } = viewport();
    const event = { key: "Shift", code: "ShiftLeft", keyCode: 16, altKey: false, ctrlKey: false,
      metaKey: false, shiftKey: true, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent<HTMLImageElement>;
    props.onKeyDown!(event);
    onReturnToToolbar.mockImplementation(() => {
      expect(input).toHaveBeenLastCalledWith({ type: "input_keyboard", eventType: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
    });
    const escape = { ...event, key: "Escape", code: "Escape", keyCode: 27 };
    props.onKeyDown!(escape); props.onKeyUp!(escape);
    expect(onReturnToToolbar).toHaveBeenCalledOnce();
    expect(input.mock.calls.map(([body]) => [body.eventType, body.key])).toEqual([["keyDown", "Shift"], ["keyUp", "Shift"]]);
    expect(event.stopPropagation).toHaveBeenCalledTimes(2);
    expect(props["aria-keyshortcuts"]).toBe("Shift+Escape");
    expect(props["aria-description"]).toContain("return to the browser address bar");
    expect(props.title).toContain("Shift+Escape");
  });

  it.each([[0, "none"], [1, "left"], [2, "right"], [4, "middle"], [8, "none"]])("preserves the held mouse button for movement (buttons=%s)", (buttons, button) => {
    const { input, props, screen } = viewport();
    props.onPointerMove!({ buttons, clientX: 20, clientY: 30, currentTarget: screen, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false } as unknown as PointerEvent<HTMLImageElement>);
    expect(input).toHaveBeenCalledExactlyOnceWith({ type: "input_mouse", eventType: "mouseMoved", x: 20, y: 30, button, modifiers: 0 });
  });

  it("uses frame dimensions instead of separately cached status, and bounds click count", () => {
    const { input, props, screen } = viewport(true, { deviceWidth: 800, deviceHeight: 600 });
    props.onPointerDown!({ button: 0, detail: 4, clientX: 640, clientY: 360, currentTarget: screen, preventDefault: vi.fn() } as unknown as PointerEvent<HTMLImageElement>);
    expect(input).toHaveBeenCalledWith(expect.objectContaining({ x: 400, y: 300, clickCount: 3 }));
  });

  it.each(["decoding", "stale", "failed"])("does not focus or send a phantom click for a %s image", (state) => {
    const { input, props, screen } = viewport();
    if (state === "decoding") screen.complete = false;
    if (state === "stale") screen.currentSrc = "previous-frame";
    if (state === "failed") screen.naturalWidth = 0;
    props.onPointerDown!({ button: 0, clientX: 20, clientY: 30, currentTarget: screen, preventDefault: vi.fn() } as unknown as PointerEvent<HTMLImageElement>);
    expect(input).not.toHaveBeenCalled();
    expect(screen.focus).not.toHaveBeenCalled();
  });

  it.each(["decoding", "stale"])("releases held input at its last valid position when pointer-up finds a %s frame", (state) => {
    const { input, props, screen } = viewport();
    const pointer = { button: 2, buttons: 2, pointerId: 1, detail: 1, clientX: 20, clientY: 30,
      currentTarget: screen, preventDefault: vi.fn(), altKey: false, ctrlKey: false, metaKey: false, shiftKey: true } as unknown as PointerEvent<HTMLImageElement>;
    const keyboard = { key: "A", code: "KeyA", keyCode: 65, altKey: false, ctrlKey: false,
      metaKey: false, shiftKey: true, nativeEvent: { isComposing: false }, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLImageElement>;
    props.onKeyDown!(keyboard);
    props.onPointerDown!(pointer);
    props.onPointerMove!({ ...pointer, clientX: 40, clientY: 50 });
    if (state === "decoding") screen.complete = false;
    else screen.currentSrc = "previous-frame";
    input.mockClear();
    props.onPointerUp!({ ...pointer, clientX: 900, clientY: 600 });
    expect(input.mock.calls.map(([body]) => body)).toEqual([
      { type: "input_mouse", eventType: "mouseReleased", x: 40, y: 50, button: "right", clickCount: 1, modifiers: 0 },
      { type: "input_keyboard", eventType: "keyUp", key: "A", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0 },
    ]);
    // Further cleanup cannot repeat a release or replay the printable key.
    props.onPointerUp!(pointer); props.onPointerCancel!(pointer);
    expect(input).toHaveBeenCalledTimes(2);
  });

  it("does not send keyboard or pointer input while just watching", () => {
    const { input, onReturnToToolbar, props } = viewport(false);
    const event = { key: "Escape", nativeEvent: { isComposing: false } } as KeyboardEvent<HTMLImageElement>;
    props.onKeyDown!(event); props.onKeyUp!(event);
    props.onKeyDown!({ ...event, shiftKey: true }); props.onKeyUp!({ ...event, shiftKey: true });
    props.onPointerMove!({ buttons: 2 } as PointerEvent<HTMLImageElement>);
    expect(input).not.toHaveBeenCalled();
    expect(onReturnToToolbar).not.toHaveBeenCalled();
    expect(props["aria-keyshortcuts"]).toBeUndefined();
  });
});

describe("browser viewport wheel forwarding", () => {
  it.each([
    { unit: "pixels", mode: 0, x: 1.25, y: -3.5, expectedX: 1.25, expectedY: -3.5 },
    { unit: "lines", mode: 1, x: 2, y: -3, expectedX: 32, expectedY: -48 },
    { unit: "pages", mode: 2, x: 1.5, y: -2, expectedX: 900, expectedY: -1200 },
    { unit: "large positive lines", mode: 1, x: 1000, y: -1000, expectedX: 10_000, expectedY: -10_000 },
    { unit: "large negative pages", mode: 2, x: -50, y: 50, expectedX: -10_000, expectedY: 10_000 },
  ])("converts $unit to bounded pixel deltas using the displayed frame height", ({ mode, x, y, expectedX, expectedY }) => {
    const { input, screen, effects } = viewport(true, { deviceWidth: 800, deviceHeight: 600 });
    const cleanup = effects[2]!();
    const listener = screen.addEventListener.mock.calls[0]![1];
    expect(screen.addEventListener).toHaveBeenCalledWith("wheel", listener, { passive: false });
    const preventDefault = vi.fn();
    listener({ clientX: 640, clientY: 360, deltaMode: mode, deltaX: x, deltaY: y,
      altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, preventDefault } as unknown as WheelEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(input).toHaveBeenCalledExactlyOnceWith({ type: "input_mouse", eventType: "mouseWheel",
      x: 400, y: 300, deltaX: expectedX, deltaY: expectedY, modifiers: 2 });
    cleanup?.();
    expect(screen.removeEventListener).toHaveBeenCalledExactlyOnceWith("wheel", listener);
  });
});

describe("browser focus-loss cleanup", () => {
  it("does not repeat normal text or already released keys on blur", () => {
    const input = vi.fn();
    const pressed = createBrowserPressedInputs(input);
    pressed.send(key("keyDown")); pressed.send(key("keyUp"));
    pressed.send({ type: "input_keyboard", eventType: "char", text: "pasted text" });
    pressed.release(); pressed.release();
    expect(input.mock.calls.map(([body]) => body)).toEqual([
      key("keyDown"), key("keyUp"), { type: "input_keyboard", eventType: "char", text: "pasted text" },
    ]);
  });

  it("releases held printable keys and modifiers exactly once without text", () => {
    const input = vi.fn();
    const pressed = createBrowserPressedInputs(input);
    pressed.send(key("keyDown", "Shift", 8));
    pressed.send(key("keyDown", "A", 8)); pressed.send(key("keyDown", "A", 8));
    pressed.release(); pressed.release();
    expect(input.mock.calls.slice(3).map(([body]) => body)).toEqual([
      key("keyUp", "A"), key("keyUp", "Shift"),
    ]);
  });

  it("releases the actual held mouse buttons at the last drag position", () => {
    const input = vi.fn();
    const pressed = createBrowserPressedInputs(input);
    const button = (eventType: string, name: string) => ({ type: "input_mouse", eventType, button: name, x: 5, y: 6 });
    pressed.send(button("mousePressed", "right")); pressed.send(button("mousePressed", "middle"));
    pressed.send(button("mouseReleased", "middle"));
    pressed.send({ type: "input_mouse", eventType: "mouseMoved", button: "right", x: 25, y: 30 });
    pressed.release();
    expect(input).toHaveBeenCalledTimes(5);
    expect(input).toHaveBeenLastCalledWith({ ...button("mouseReleased", "right"), x: 25, y: 30, modifiers: 0 });
  });
});
