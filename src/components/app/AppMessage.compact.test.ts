// @vitest-environment happy-dom
// A bot's page in its own chat: a compact card that opens the chat's page pane from anywhere on it.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type Message, type useStore } from "@/state/store";
import type { AppPayload } from "../../../shared/app";
import { botHtmlDocument } from "../../../shared/app-frame/document";
import { createAppPool } from "./app-pool";
import { AppMessage, forgetAppRows } from "./AppMessage";
import { PAGE_PREVIEW_HEIGHT, PagePaneContext } from "./PageTools";

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
const render = async (message: Message) => {
  await act(async () => {
    root.render(createElement(BotEditorStore, { value: store, children:
      createElement(PagePaneContext, { value: pane },
        createElement(AppMessage, { botId: "pepper", botName: "Pepper", threadId: "t1", message, pool: createAppPool({ limit: 3 }) })) }));
  });
  await settle();
};
const card = () => host.querySelector<HTMLElement>("[data-app=a1]")!;
const opener = () => card().querySelector<HTMLButtonElement>("[data-page-open]")!;
const press = (element: HTMLElement) => act(async () => { element.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(botHtmlDocument({ messageId: "a1", rev: 0, html: "<p>page</p>" })),
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
  it("shows only the preview and a footer with the title and what it is", async () => {
    await render(row(payload()));
    expect(card().querySelector<HTMLElement>("[data-app-box]")!.style.height).toBe(`${PAGE_PREVIEW_HEIGHT}px`);
    expect(card().querySelector("[data-page-footer]")!.textContent).toBe("PricingPage");
    expect(card().querySelector("[data-app-header]")).toBeNull();
    expect(card().querySelector("[data-page-tools]")).toBeNull();
    expect(Array.from(card().querySelectorAll("button"), (button) => button.getAttribute("aria-label"))).toEqual(["About this app", "Reload app", "Open page"]);
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

  it("keeps the card's own tools working without opening the page", async () => {
    await render(row(payload()));
    await press(card().querySelector<HTMLButtonElement>("[aria-label='About this app']")!);
    expect(card().querySelector("[data-app-info]")).not.toBeNull();
    expect(pane.querySelector("[data-page-pane]")).toBeNull();
  });
});
