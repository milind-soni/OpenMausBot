import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";

import { APP_HEADING_METHOD, APP_HELPER_SOURCE, APP_OPENS_WITH_HEADING_SOURCE } from "./helper.ts";

const pages: Window[] = [];
afterEach(async () => { for (const page of pages.splice(0)) await page.happyDOM.close(); });

function open(body: string, head = ""): Window {
  const page = new Window();
  pages.push(page);
  page.document.head.innerHTML = head;
  page.document.body.innerHTML = body;
  return page;
}

const opensWithHeading = (page: Window) =>
  (new Function(`return ${APP_OPENS_WITH_HEADING_SOURCE}`)() as (window: unknown, document: unknown) => boolean | null)(page, page.document);

describe("whether a page opens with a heading of its own", () => {
  it("is so when the first text it shows is a heading, whatever the heading says", () => {
    expect(opensWithHeading(open("<h1>Pricing</h1><p>body</p>"))).toBe(true);
    expect(opensWithHeading(open("<main><section><h2>Not the page's title at all</h2></section></main>"))).toBe(true);
    expect(opensWithHeading(open("<div role=\"heading\" aria-level=\"1\">Pricing</div><p>body</p>"))).toBe(true);
  });

  it("is not so when the first text it shows is anything else", () => {
    expect(opensWithHeading(open("<p>body</p><h1>Pricing</h1>"))).toBe(false);
    expect(opensWithHeading(open("<div class=\"tile\"><b>4.2.0</b> on the server</div><h2>Later</h2>"))).toBe(false);
  });

  it("does not count a heading the page hides with CSS", () => {
    expect(opensWithHeading(open("<h1 style=\"display:none\">Hidden</h1><p>body</p>"))).toBe(false);
    expect(opensWithHeading(open("<h1 class=\"gone\">Hidden</h1><p>body</p>", "<style>.gone{display:none}</style>"))).toBe(false);
    expect(opensWithHeading(open("<h1 style=\"visibility:hidden\">Hidden</h1><p>body</p>"))).toBe(false);
    expect(opensWithHeading(open("<header hidden><h1>Hidden</h1></header><p>body</p>"))).toBe(false);
  });

  it("does not count text the page shows at no opacity", () => {
    expect(opensWithHeading(open("<h1 style=\"opacity:0\">Hidden</h1><p>body</p>"))).toBe(false);
    expect(opensWithHeading(open("<header class=\"clear\"><h1>Hidden</h1></header><p>body</p>", "<style>.clear{opacity:0}</style>"))).toBe(false);
    expect(opensWithHeading(open("<p style=\"opacity:0\">Hidden</p><h1>Title</h1>"))).toBe(true);
    expect(opensWithHeading(open("<h1 style=\"opacity:0.4\">Faint</h1><p>body</p>"))).toBe(true);
  });

  it("looks past hidden text that comes before a heading", () => {
    expect(opensWithHeading(open("<p style=\"display:none\">Hidden</p><h1>Title</h1>"))).toBe(true);
    expect(opensWithHeading(open("<p class=\"gone\">Hidden</p><h1>Title</h1>", "<style>.gone{display:none}</style>"))).toBe(true);
    expect(opensWithHeading(open("<script>var a = 1;</script><template><p>x</p></template><noscript>off</noscript><h1>Title</h1>"))).toBe(true);
  });

  it("has no answer for a page that shows no text yet", () => {
    expect(opensWithHeading(open("<div id=\"root\"></div><script>render()</script>"))).toBeNull();
  });
});

describe("the page helper's heading report", () => {
  /** The helper in a fake frame over a real document: the host answers ui/initialize and keeps what the page reports. */
  function boot(body: string) {
    const page = open(body);
    const reports: (boolean | null)[] = [];
    const listeners = new Set<(event: { source: unknown; data: unknown }) => void>();
    const parent = {
      postMessage(data: { id?: string; method?: string; params?: { heading?: boolean | null } }) {
        if (data.method === APP_HEADING_METHOD) reports.push(data.params!.heading!);
        if (data.method === "ui/initialize") setTimeout(() => { for (const listener of listeners) listener({ source: parent, data: { jsonrpc: "2.0", id: data.id, result: {} } }); }, 0);
      },
    };
    const frame = {
      parent, innerWidth: 560, innerHeight: 400, scrollY: 0,
      addEventListener(type: string, listener: (event: { source: unknown; data: unknown }) => void) { if (type === "message") listeners.add(listener); },
      getComputedStyle: (element: unknown) => page.getComputedStyle(element as never),
    };
    Object.defineProperty(page.document, "readyState", { configurable: true, get: () => "complete" });
    new Function("window", "document", "MutationObserver", "ResizeObserver", "requestAnimationFrame", APP_HELPER_SOURCE)(
      frame, page.document, page.MutationObserver, undefined, (callback: () => void) => setTimeout(callback, 0));
    return { page, frame, reports };
  }

  it("says once whether the page opens with a heading", async () => {
    const titled = boot("<h1>Pricing</h1><p>body</p>");
    await expect.poll(() => titled.reports).toEqual([true]);
    const plain = boot("<p>body</p>");
    await expect.poll(() => plain.reports).toEqual([false]);
  });

  it("waits for a page that draws itself from a script, and reports the heading the script inserts", async () => {
    const { page, reports } = boot("<div id=\"root\"></div>");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reports).toEqual([]);
    page.document.getElementById("root")!.innerHTML = "<h1>Drawn by a script</h1><p>body</p>";
    await expect.poll(() => reports).toEqual([true]);
  });

  it("says a jsx page is still drawing, then what it drew, however long its libraries take", async () => {
    const { page, reports } = boot("<div id=\"mausbot-root\"></div>");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(reports).toEqual([null]);
    page.document.getElementById("mausbot-root")!.innerHTML = "<main><h1>Drawn by React</h1><p>body</p></main>";
    await expect.poll(() => reports).toEqual([null, true]);
  });

  it("says again when the page changes what it opens with", async () => {
    const { page, reports } = boot("<p>Loading the report</p>");
    await expect.poll(() => reports).toEqual([false]);
    page.document.body.innerHTML = "<h1>Report</h1>";
    await expect.poll(() => reports).toEqual([false, true]);
    page.document.querySelector("h1")!.setAttribute("style", "display:none");
    page.document.body.append(Object.assign(page.document.createElement("p"), { textContent: "body" }) as never);
    await expect.poll(() => reports).toEqual([false, true, false]);
  });

  it("looks again when a fade the page runs has ended", async () => {
    const { page, frame, reports } = boot("<h1>Fading in</h1><p>body</p>");
    // an animation moves no attribute, so nothing but its end tells the helper
    const real = frame.getComputedStyle;
    let clear = true;
    frame.getComputedStyle = (element) => {
      const style = real(element);
      return clear && (element as { tagName?: string }).tagName === "H1" ? { display: "block", visibility: "visible", opacity: "0" } as never : style;
    };
    await expect.poll(() => reports).toEqual([false]);
    clear = false;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reports).toEqual([false]);
    page.document.querySelector("h1")!.dispatchEvent(new page.Event("animationend", { bubbles: true }) as never);
    await expect.poll(() => reports).toEqual([false, true]);
  });

  it("settles on no heading for a page that never shows any text", async () => {
    const { reports } = boot("<canvas></canvas>");
    await expect.poll(() => reports, { timeout: 3_000 }).toEqual([false]);
  });
});
