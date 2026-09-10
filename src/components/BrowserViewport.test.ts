import { Children, createElement, type ImgHTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrowserViewport, createBrowserPressedInputs } from "./BrowserViewport";

const key = (eventType: string, value = "a", modifiers = 0) => ({
  type: "input_keyboard", eventType, key: value, code: value === "Shift" ? "ShiftLeft" : "KeyA", modifiers,
  ...(eventType === "keyDown" && value.length === 1 ? { text: value } : {}),
});

function viewport(driving = true) {
  const input = vi.fn();
  const onReturnToToolbar = vi.fn();
  let image!: ReactElement<ImgHTMLAttributes<HTMLImageElement>>;
  function Capture() {
    const tree = BrowserViewport({ frame: { seq: 1, data: "fixture" }, width: 1280, height: 720,
      driving, input, acknowledge: vi.fn(), onDecodeError: vi.fn(), onReturnToToolbar });
    image = Children.only(tree.props.children) as typeof image;
    return tree;
  }
  renderToStaticMarkup(createElement(Capture));
  return { input, onReturnToToolbar, props: image.props };
}

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
    const { input, props } = viewport();
    props.onPointerMove!({ buttons, clientX: 20, clientY: 30, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false } as PointerEvent<HTMLImageElement>);
    expect(input).toHaveBeenCalledExactlyOnceWith({ type: "input_mouse", eventType: "mouseMoved", x: 0, y: 0, button, modifiers: 0 });
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
