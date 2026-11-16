// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type Message, type useStore } from "@/state/store";
import type { AppPayload } from "../../../shared/app";
import { botHtmlDocument } from "../../../shared/app-frame/document";
import { createAppPool } from "./app-pool";
import { AppMessage, forgetAppRows } from "./AppMessage";
import { PAGE_PREVIEW_HEIGHT, PagePaneContext } from "./PageTools";
import portuguese from "@/locales/pt-br.json";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const payload = (more: Partial<AppPayload> = {}): AppPayload => ({
  v: 1, source: "html", title: "Pricing", doc: "d0", rev: 0, bytes: 900, border: true, network: { connect: [], resources: [] }, ...more,
});
const row = (app: AppPayload): Message => ({ id: "a1", role: "bot", kind: "app", at: 1, text: "[App] Pricing", app });
const store = { state: {}, dispatch: vi.fn(), flushBotPatches: vi.fn(async () => null) } as unknown as ReturnType<typeof useStore>;

let host: HTMLDivElement;
let pane: HTMLDivElement;
let root: Root;

const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const render = async (message: Message, room = false) => {
  await act(async () => {
    root.render(createElement(BotEditorStore, { value: store, children:
      createElement(PagePaneContext, { value: room ? null : pane },
        createElement(AppMessage, { botId: "pepper", botName: "Pepper", threadId: "t1", message, room, pool: createAppPool({ limit: 3 }) })) }));
  });
  await settle();
};
const card = () => host.querySelector<HTMLElement>("[data-app=a1]")!;
const opener = () => card().querySelector<HTMLButtonElement>("[data-page-open]")!;
const press = (element: HTMLElement) => act(async () => { element.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

let html: string;

beforeEach(() => {
  html = "<p>page</p>";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(botHtmlDocument({ messageId: "a1", rev: 0, html })),
    { status: 200, headers: { "content-type": "application/json" } })));
  vi.stubGlobal("IntersectionObserver", undefined);
  forgetAppRows();
  host = document.createElement("div");
  pane = document.createElement("div");
  document.body.append(host, pane);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  pane.remove();
  vi.unstubAllGlobals();
});

describe("a bot's page as a compact card", () => {
  it("keeps the keyboard out of the preview, in a chat and in a room, and leaves the card's own buttons reachable", async () => {
    for (const room of [false, true]) {
      await render(row(payload()), room);
      const box = card().querySelector<HTMLElement>("[data-app-box]")!;
      expect(box.querySelector("iframe")).not.toBeNull();
      expect(box.hasAttribute("inert")).toBe(true);
      expect(opener().closest("[inert]")).toBeNull();
      expect(card().querySelector("[data-page-footer]")!.closest("[inert]")).toBeNull();
    }
  });

  it("shows only the preview and a footer with the title and what it is", async () => {
    await render(row(payload()));
    expect(card().querySelector<HTMLElement>("[data-app-box]")!.style.height).toBe(`${PAGE_PREVIEW_HEIGHT}px`);
    expect(card().querySelector("[data-page-footer]")!.textContent).toBe("PricingPage");
    expect(card().querySelector("[data-app-header]")).toBeNull();
    expect(card().querySelector("[data-page-tools]")).toBeNull();
    expect(Array.from(card().querySelectorAll("button"), (button) => button.getAttribute("aria-label"))).toEqual(["About this app", "Reload app", "Open page"]);
  });

  it("is narrower than a full page, start-aligned in the message column", async () => {
    await render(row(payload()));
    expect(card().className).toContain("max-w-[560px]");
    expect(card().className).not.toContain("max-w-[760px]");
  });

  it("puts the title above a page that has no heading of its own", async () => {
    await render(row(payload()));
    const box = card().querySelector<HTMLElement>("[data-app-box]")!;
    expect(box.firstElementChild!.matches("[data-page-title]")).toBe(true);
    expect(box.firstElementChild!.textContent).toBe("Pricing");
    expect(box.querySelector("[data-page-title] ~ [data-app-frame-box]")).not.toBeNull();
  });

  it("leaves the top of the preview to a page that opens with its own heading", async () => {
    html = "<h1>Pricing</h1><p>page</p>";
    await render(row(payload()));
    expect(card().querySelector("[data-page-title]")).toBeNull();
    expect(card().querySelector("[data-app-box]")!.firstElementChild!.matches("[data-app-frame-box]")).toBe(true);
    expect(card().querySelector("[data-page-footer]")!.textContent).toBe("PricingPage");
  });

  it("fades the foot of a clipped preview with a plain gradient and parts it from the footer with a rule", async () => {
    await render(row(payload()));
    const fade = card().querySelector<HTMLElement>("[data-app-box] > [data-page-fade]")!;
    expect(fade.className).toContain("bg-gradient-to-t from-composer to-transparent");
    expect(fade.className).toContain("h-8");
    expect(fade.className).not.toMatch(/blur|mask|backdrop/);
    expect(card().querySelector("[data-page-footer]")!.className).toContain("border-t");
  });

  it("shows a short page whole, with nothing over its foot", async () => {
    await render(row(payload({ height: 120 })));
    expect(card().querySelector<HTMLElement>("[data-app-box]")!.style.height).toBe("164px");
    expect(card().querySelector("[data-page-fade]")).toBeNull();
  });

  it("gives the footer the page's icon on a tile, the title and what it is", async () => {
    await render(row(payload()));
    const footer = card().querySelector<HTMLElement>("[data-page-footer]")!;
    expect(footer.className).toContain("min-h-18");
    expect(footer.firstElementChild!.matches("[data-page-icon]")).toBe(true);
    expect(footer.querySelector("[data-page-icon] svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("has a Brazilian Portuguese word for what the card is", () => {
    expect((portuguese as Record<string, string>)["chat.preview.kind"]).toBe("Página");
  });

  it("names the version once the page has been updated", async () => {
    await render(row(payload({ rev: 1, doc: "d1", history: ["d0"] })));
    expect(card().querySelector("[data-page-footer]")!.textContent).toBe("PricingPage · v2");
  });

  it("opens the page pane with its tools from the card, and closes it again", async () => {
    await render(row(payload()));
    expect(opener().getAttribute("aria-pressed")).toBe("false");
    await press(opener());
    const opened = pane.querySelector<HTMLElement>("[data-page-pane=a1]")!;
    expect(opened.querySelector("[data-page-tools]")).not.toBeNull();
    expect(opener().getAttribute("aria-pressed")).toBe("true");
    expect(opener().getAttribute("aria-label")).toBe("Close page");
    await press(opener());
    expect(pane.querySelector("[data-page-pane]")).toBeNull();
  });

  it("turns Point off when the open page asks to be closed, so the card opens it again", async () => {
    for (const room of [false, true]) {
      await render(row(payload()), room);
      await press(opener());
      const opened = document.querySelector<HTMLElement>("[data-page-fullscreen=a1]")!;
      const view = opened.querySelector("iframe")!.contentWindow!;
      vi.spyOn(view, "postMessage").mockImplementation(() => {});
      const point = Array.from(opened.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Point")!;
      await press(point);
      expect(point.getAttribute("aria-pressed")).toBe("true");
      for (const data of [{ id: "init", method: "ui/initialize" }, { method: "ui/notifications/initialized" }, { method: "ui/notifications/request-teardown" }]) {
        await act(async () => { window.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", params: {}, ...data }, source: view as unknown as MessageEventSource })); });
      }
      await settle();
      expect(document.querySelector("[data-page-fullscreen]")).toBeNull();
      expect(opener().getAttribute("aria-pressed")).toBe("false");
      expect(card().querySelector("[data-app-box]")!.hasAttribute("inert")).toBe(true);
    }
  });

  it("keeps the card's own tools working without opening the page", async () => {
    await render(row(payload()));
    await press(card().querySelector<HTMLButtonElement>("[aria-label='About this app']")!);
    expect(card().querySelector("[data-app-info]")).not.toBeNull();
    expect(pane.querySelector("[data-page-pane]")).toBeNull();
  });

  it("is the same card in a room, where it opens over the window", async () => {
    await render(row(payload()), true);
    expect(card().querySelector<HTMLElement>("[data-app-box]")!.style.height).toBe(`${PAGE_PREVIEW_HEIGHT}px`);
    expect(card().querySelector("[data-page-footer]")!.textContent).toBe("PricingPage");
    expect(card().querySelector("[data-app-header]")).toBeNull();
    expect(card().querySelector("[data-page-tools]")).toBeNull();
    await press(opener());
    const opened = document.body.querySelector<HTMLElement>("[role=dialog][data-page-fullscreen=a1]")!;
    expect(opened.querySelector("[data-page-tools]")).not.toBeNull();
    expect(pane.querySelector("[data-page-pane]")).toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(document.body.querySelector("[data-page-fullscreen]")).toBeNull();
    expect(opener().getAttribute("aria-pressed")).toBe("false");
  });
});
