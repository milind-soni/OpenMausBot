// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakePhoneSocket, FakeVideoDecoder, PHONE_CONFIG, fakePhoneStream, showPage } from "@/testing/phone-stream";
import { PhoneScreenPanel } from "./PhoneScreenPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let animationFrames: Array<() => void> = [];

type Shown = { box?: { left: number; top: number; width: number; height: number }; frame?: { width: number; height: number } };

const panel = (serial: string) => createElement(PhoneScreenPanel, { serial, name: "Pixel" });

/** The panel for phone p1, with its screen 720 by 640 at the page's corner unless `box` says otherwise. */
async function mount({ box = { left: 0, top: 0, width: 720, height: 640 } }: Shown = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(panel("p1")));
  const screen = container.querySelector<HTMLElement>('[role="application"]')!;
  screen.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) });
  return { screen, socket: FakePhoneSocket.current };
}

/** A frame, 720 by 1280 unless `frame` says otherwise, is on the canvas: fitted into the default screen it is 360 by
 * 640, starting 180 from the left. */
async function watching(shown: Shown = {}) {
  const { width, height } = shown.frame ?? { width: 720, height: 1280 };
  const mounted = await mount(shown);
  act(() => {
    mounted.socket.packet(1, PHONE_CONFIG);
    FakeVideoDecoder.current.frame(width, height);
  });
  return mounted;
}

async function holding(shown: Shown = {}) {
  const mounted = await watching(shown);
  act(() => mounted.socket.control(true));
  return mounted;
}

const pointer = (screen: HTMLElement, type: string, clientX: number, clientY: number, more: PointerEventInit = {}) =>
  act(() => { screen.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, clientY, pointerId: 1, ...more })); });
const press = (screen: HTMLElement, key: string, more: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...more });
  act(() => { screen.dispatchEvent(event); });
  return event;
};
const nextAnimationFrame = () => act(() => { for (const run of animationFrames.splice(0)) run(); });
const button = (label: string) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
const click = (label: string) => act(() => button(label)!.click());
const textField = () => document.querySelector<HTMLInputElement>('input[type="text"]')!;
const submit = (text: string) => act(() => {
  textField().value = text;
  textField().form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
});
const compose = (type: "compositionstart" | "compositionend") => act(() => { textField().dispatchEvent(new Event(type, { bubbles: true })); });
const touch = (action: string, x: number, y: number) => ({ type: "touch", action, x, y, w: 720, h: 1280 });

beforeEach(() => {
  fakePhoneStream();
  animationFrames = [];
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => animationFrames.push(run));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { animationFrames[id - 1] = () => {}; });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  Reflect.deleteProperty(document, "visibilityState");
  vi.unstubAllGlobals();
});

describe("watching the phone", () => {
  it("opens the phone's stream and shows a spinner until the first frame", async () => {
    const { socket, screen } = await mount();
    expect(socket.url.endsWith("/api/usb-phones/p1/stream")).toBe(true);
    expect(screen.getAttribute("aria-label")).toBe("Interactive Android screen for Pixel");
    expect(screen.tabIndex).toBe(0);
    expect(screen.querySelector(".animate-spin")).not.toBeNull();
    act(() => {
      socket.packet(1, PHONE_CONFIG);
      FakeVideoDecoder.current.frame(720, 1280);
    });
    expect(screen.querySelector(".animate-spin")).toBeNull();
  });

  it("says the bots keep working and sends no pointer, key or text input", async () => {
    const { socket, screen } = await watching();
    expect(document.body.textContent).toContain("Watching · the bots keep working");
    pointer(screen, "pointerdown", 270, 160);
    pointer(screen, "pointermove", 360, 320);
    nextAnimationFrame();
    pointer(screen, "pointerup", 360, 320);
    press(screen, "Enter");
    press(screen, "a");
    expect(button("Back")!.disabled).toBe(true);
    expect(button("Wake")!.disabled).toBe(true);
    expect(textField().disabled).toBe(true);
    submit("hello");
    expect(socket.sent).toEqual([]);
  });

  it("takes control with the Take control button", async () => {
    const { socket } = await watching();
    click("Take control");
    expect(socket.sent).toEqual([{ type: "take" }]);
  });

  it("keeps Take control disabled until the first frame", async () => {
    const { socket } = await mount();
    expect(button("Take control")!.disabled).toBe(true);
    act(() => {
      socket.packet(1, PHONE_CONFIG);
      FakeVideoDecoder.current.frame(720, 1280);
    });
    expect(button("Take control")!.disabled).toBe(false);
  });

  it.each([
    ["goes away", () => act(() => root!.unmount())],
    ["shows another phone", () => act(() => root!.render(panel("p2")))],
  ])("closes the phone's stream when the panel %s", async (_name, leave) => {
    const { socket } = await watching();
    const decoder = FakeVideoDecoder.current;
    leave();
    expect(socket.readyState).toBe(3);
    expect(decoder.state).toBe("closed");
  });
});

describe("driving the phone", () => {
  it("says the person is in control and hands the phone back with the button", async () => {
    const { socket } = await holding();
    expect(document.body.textContent).toContain("You're in control");
    expect(button("Take control")).toBeUndefined();
    click("Hand control back");
    expect(socket.sent).toEqual([{ type: "handBack" }]);
  });

  it("sends a press, the drag and the release in the frame's own pixels", async () => {
    const { socket, screen } = await holding();
    pointer(screen, "pointerdown", 270, 160);
    pointer(screen, "pointermove", 360, 320);
    nextAnimationFrame();
    pointer(screen, "pointerup", 450, 480);
    expect(socket.sent).toEqual([touch("down", 180, 320), touch("move", 360, 640), touch("up", 540, 960)]);
  });

  it("sends one move an animation frame, the latest, and keeps a drag that leaves the picture on its edge", async () => {
    const { socket, screen } = await holding();
    pointer(screen, "pointerdown", 270, 160);
    pointer(screen, "pointermove", 300, 200);
    pointer(screen, "pointermove", 360, 320);
    nextAnimationFrame();
    pointer(screen, "pointermove", 700, 320);
    nextAnimationFrame();
    nextAnimationFrame();
    expect(socket.sent).toEqual([touch("down", 180, 320), touch("move", 360, 640), touch("move", 719, 640)]);
  });

  it("puts a release below the picture on its bottom row, and a drag past its left and top edges on the first", async () => {
    const { socket, screen } = await holding();
    pointer(screen, "pointerdown", 270, 160);
    pointer(screen, "pointermove", 100, -20);
    nextAnimationFrame();
    pointer(screen, "pointerup", 360, 700);
    expect(socket.sent).toEqual([touch("down", 180, 320), touch("move", 0, 0), touch("up", 360, 1279)]);
  });

  it("finds the pixel under the pointer when the screen is not at the page's corner", async () => {
    const { socket, screen } = await holding({ box: { left: 40, top: 100, width: 720, height: 640 } });
    pointer(screen, "pointerdown", 310, 260);
    pointer(screen, "pointerup", 400, 420);
    expect(socket.sent).toEqual([touch("down", 180, 320), touch("up", 360, 640)]);
  });

  it("maps a landscape frame in a tall screen from its middle band, and ignores a press in the bar above it", async () => {
    const landscape = { width: 1280, height: 720 };
    const { socket, screen } = await holding({ box: { left: 0, top: 0, width: 320, height: 640 }, frame: landscape });
    pointer(screen, "pointerdown", 160, 100);
    pointer(screen, "pointerup", 160, 100);
    expect(socket.sent).toEqual([]);

    pointer(screen, "pointerdown", 160, 320);
    pointer(screen, "pointerup", 160, 320);
    expect(socket.sent).toEqual(["down", "up"].map((action) => ({ type: "touch", action, x: 640, y: 360, w: 1280, h: 720 })));
  });

  it("captures the pointer on a press", async () => {
    const { screen } = await holding();
    pointer(screen, "pointerdown", 270, 160);
    expect(screen.hasPointerCapture(1)).toBe(true);
  });

  it("sends no touch for a right-click, or for a second pointer pressed during a press", async () => {
    const { socket, screen } = await holding();
    pointer(screen, "pointerdown", 270, 160, { button: 2 });
    pointer(screen, "pointerup", 270, 160, { button: 2 });
    expect(socket.sent).toEqual([]);

    pointer(screen, "pointerdown", 270, 160);
    pointer(screen, "pointerdown", 360, 320, { pointerId: 2 });
    pointer(screen, "pointerup", 450, 480);
    expect(socket.sent).toEqual([touch("down", 180, 320), touch("up", 540, 960)]);
  });

  it("leaves a press where it is when another pointer moves or lifts", async () => {
    const { socket, screen } = await holding();
    pointer(screen, "pointerdown", 270, 160);
    pointer(screen, "pointermove", 360, 320, { pointerId: 2 });
    nextAnimationFrame();
    pointer(screen, "pointerup", 360, 320, { pointerId: 2 });
    pointer(screen, "pointerup", 270, 160);
    expect(socket.sent).toEqual([touch("down", 180, 320), touch("up", 180, 320)]);
  });

  it("ignores a press beside the picture, and moves with nothing pressed", async () => {
    const { socket, screen } = await holding();
    pointer(screen, "pointerdown", 100, 160);
    pointer(screen, "pointermove", 360, 320);
    nextAnimationFrame();
    pointer(screen, "pointerup", 360, 320);
    expect(socket.sent).toEqual([]);
  });

  it.each(["pointercancel", "lostpointercapture"])("lifts the finger where it last was on %s, once", async (lost) => {
    const { socket, screen } = await holding();
    pointer(screen, "pointerdown", 270, 160);
    pointer(screen, "pointermove", 360, 320);
    pointer(screen, lost, 0, 0);
    nextAnimationFrame();
    pointer(screen, "pointerup", 450, 480);
    expect(socket.sent).toEqual([touch("down", 180, 320), touch("up", 360, 640)]);
  });

  it("stops sending a drag once the phone is no longer held", async () => {
    const { socket, screen } = await holding();
    pointer(screen, "pointerdown", 270, 160);
    act(() => socket.control(false));
    pointer(screen, "pointermove", 360, 320);
    nextAnimationFrame();
    pointer(screen, "pointerup", 360, 320);
    expect(socket.sent).toEqual([touch("down", 180, 320)]);
  });

  it("disables the buttons and the text field and sends nothing while the stream connects again, still held", async () => {
    const { screen } = await holding();
    act(() => {
      showPage(false);
      showPage(true);
    });
    expect(FakePhoneSocket.all).toHaveLength(2);
    expect(document.body.textContent).toContain("You're in control");
    for (const label of ["Hand control back", "Back", "Home", "Recent", "Wake"]) expect(button(label)!.disabled).toBe(true);
    expect(textField().disabled).toBe(true);

    pointer(screen, "pointerdown", 270, 160);
    pointer(screen, "pointermove", 360, 320);
    nextAnimationFrame();
    pointer(screen, "pointerup", 360, 320);
    press(screen, "Enter");
    press(screen, "a");
    submit("hello");
    expect(FakePhoneSocket.current.sent).toEqual([]);
  });

  it("sends the four buttons as keys", async () => {
    const { socket } = await holding();
    for (const label of ["Back", "Home", "Recent", "Wake"]) click(label);
    expect(socket.sent).toEqual(["back", "home", "recent", "wakeup"].map((key) => ({ type: "key", key })));
  });

  it("sends the keyboard's editing and arrow keys as keys, Escape as back, and what it types as text", async () => {
    const { socket, screen } = await holding();
    for (const key of ["Enter", "Backspace", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"]) press(screen, key);
    press(screen, "a");
    press(screen, "é");
    press(screen, "Shift");
    press(screen, "c", { ctrlKey: true });
    expect(socket.sent).toEqual([
      ...["enter", "delete", "tab", "up", "down", "left", "right", "back"].map((key) => ({ type: "key", key })),
      { type: "text", text: "a" },
      { type: "text", text: "é" },
    ]);
  });

  it("leaves Shift+Tab to the browser and sends nothing, and still sends Tab", async () => {
    const { socket, screen } = await holding();
    expect(press(screen, "Tab", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(socket.sent).toEqual([]);

    expect(press(screen, "Tab").defaultPrevented).toBe(true);
    expect(socket.sent).toEqual([{ type: "key", key: "tab" }]);
  });

  it("sends the text field on Enter and clears it, but nothing while an input method is composing", async () => {
    const { socket } = await holding();
    compose("compositionstart");
    submit("ni hao");
    expect(socket.sent).toEqual([]);
    expect(textField().value).toBe("ni hao");

    compose("compositionend");
    submit("你好");
    expect(socket.sent).toEqual([{ type: "text", text: "你好" }]);
    expect(textField().value).toBe("");
  });
});

describe("a phone screen that cannot be shown", () => {
  it("always notes what stays black on Android 12 and later", async () => {
    await mount();
    expect(document.body.textContent).toContain("On Android 12 and later, the lock screen and protected pages appear black here; do those steps on the phone.");
  });

  it("explains what the live screen needs when the browser cannot decode it", async () => {
    vi.stubGlobal("isSecureContext", false);
    await mount();
    expect(document.body.textContent).toContain("The live phone screen needs HTTPS or localhost and a browser with WebCodecs.");
    expect(button("Take control")).toBeUndefined();
    expect(FakePhoneSocket.all).toHaveLength(0);
  });

  it("shows why the screen failed and connects again on Retry", async () => {
    const { socket } = await holding();
    act(() => socket.closeWith(1011, "The phone's screen could not start."));
    expect(document.body.textContent).toContain("The phone's screen could not start.");
    expect(button("Hand control back")).toBeUndefined();
    click("Retry");
    expect(FakePhoneSocket.all).toHaveLength(2);
    expect(document.body.textContent).not.toContain("The phone's screen could not start.");
    expect(button("Take control")).toBeDefined();
  });

  it("shows why the phone is gone, with nothing to retry", async () => {
    const { socket } = await watching();
    act(() => socket.closeWith(4404, "The phone was unplugged."));
    expect(document.body.textContent).toContain("The phone was unplugged.");
    expect(button("Retry")).toBeUndefined();
  });
});
