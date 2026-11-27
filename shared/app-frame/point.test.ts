// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { APP_POINT_SOURCE, marksMessage, POINT_ENDED_METHOD, POINT_LIMITS, POINTED_METHOD, pointedLabel, pointMessage, readPointEvent } from "./point.ts";

const frame = { name: "the page's window" };
const pick = (params: Record<string, unknown>) => ({ jsonrpc: "2.0", method: POINTED_METHOD, params });
const PART = { tag: "button", role: "button", text: "Choose Pro", selector: "main > section:nth-of-type(2) > button", html: "<button>Choose Pro</button>" };

describe("readPointEvent", () => {
  it("takes a pick only from the frame's own window", () => {
    expect(readPointEvent({ source: frame, data: pick(PART) }, frame)).toEqual({ kind: "pointed", part: PART });
    expect(readPointEvent({ source: { name: "another window" }, data: pick(PART) }, frame)).toBeNull();
    expect(readPointEvent({ source: null, data: pick(PART) }, frame)).toBeNull();
    expect(readPointEvent({ source: frame, data: pick(PART) }, null)).toBeNull();
    expect(readPointEvent({ source: frame, data: { jsonrpc: "2.0", method: POINT_ENDED_METHOD, params: {} } }, frame)).toEqual({ kind: "ended" });
  });

  it("drops a malformed pick and clips what the page says", () => {
    for (const data of [
      null, "pointed", { method: POINTED_METHOD, params: PART }, { jsonrpc: "2.0", id: 1, method: POINTED_METHOD, params: PART },
      pick({ ...PART, tag: "<img onerror=x>" }), pick({ ...PART, tag: 7 }), pick({ ...PART, selector: "" }), { jsonrpc: "2.0", method: "other", params: PART },
    ]) expect(readPointEvent({ source: frame, data }, frame), JSON.stringify(data)).toBeNull();
    const long = readPointEvent({ source: frame, data: pick({ ...PART, tag: "DIV", role: "not a role!", text: `a b\u0000c ${"x".repeat(500)}`, html: "<p>".repeat(400) }) }, frame);
    if (long?.kind !== "pointed") throw new Error("not a pick");
    expect(long.part.tag).toBe("div");
    expect(long.part.role).toBe("");
    expect(long.part.text.startsWith("a b c xx")).toBe(true);
    expect(Array.from(long.part.text)).toHaveLength(POINT_LIMITS.text);
    expect(Array.from(long.part.html)).toHaveLength(POINT_LIMITS.html);
  });

  it("labels a chip by the part's own words, or not at all", () => {
    expect(pointedLabel({ text: "Choose Pro" })).toBe("“Choose Pro”");
    expect(pointedLabel({ text: "   " })).toBeNull();
    expect(Array.from(pointedLabel({ text: "y".repeat(80) })!)).toHaveLength(POINT_LIMITS.label + 2);
  });
});

describe("the page's point script", () => {
  type Listener = (event: { source: unknown; data: unknown }) => void;
  const posted: unknown[] = [];
  // Point stays on after a pick, and every boot listens on the one window, so each test turns its scripts off after it.
  const booted: Array<(data: unknown) => void> = [];
  afterEach(() => {
    for (const say of booted.splice(0)) say(pointMessage(false));
    posted.length = 0;
    document.body.innerHTML = "";
    document.documentElement.style.cursor = "";
  });

  function boot() {
    document.body.innerHTML = `<main><section id="plans"><div class="card"><h2>Starter</h2><button>Choose Starter</button></div>
      <div class="card" data-name="Pro"><h2>Pro</h2><button>Choose Pro</button></div></section><footer><a href="#">Terms</a></footer></main>`;
    const parent = { postMessage: (data: unknown) => posted.push(structuredClone(data)) };
    const messages = new Set<Listener>();
    const fake = new Proxy(window, {
      get(target, key) {
        if (key === "parent") return parent;
        if (key === "addEventListener") return (type: string, listener: EventListener, options?: AddEventListenerOptions | boolean) => {
          if (type === "message") messages.add(listener as unknown as Listener);
          else window.addEventListener(type, listener, options);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    new Function("window", "document", APP_POINT_SOURCE)(fake, document);
    const say = (data: unknown, source: unknown = parent) => { for (const listener of messages) listener({ source, data }); };
    booted.push(say);
    return { say };
  }
  const click = (element: Element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  it("describes each clicked element to its parent while point mode is on, and stays on until the parent turns it off", () => {
    const { say } = boot();
    const pro = document.querySelectorAll("button")[0]!;
    click(pro);
    expect(posted).toEqual([]);
    say(pointMessage(true), { name: "not the parent" });
    click(pro);
    expect(posted).toEqual([]);
    say(pointMessage(true));
    expect(document.documentElement.style.cursor).toBe("crosshair");
    pro.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    expect(document.querySelector("[data-mausbot-point]")).not.toBeNull();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    pro.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(posted).toEqual([pick({ tag: "button", role: "button", text: "Choose Starter", selector: "#plans > div:nth-of-type(1) > button", html: "<button>Choose Starter</button>" })]);
    expect(document.documentElement.style.cursor).toBe("crosshair");
    click(document.querySelector("a")!);
    expect(posted).toHaveLength(2);
    expect(posted.at(-1)).toMatchObject({ params: { tag: "a", text: "Terms" } });
    say(pointMessage(false));
    expect(document.documentElement.style.cursor).toBe("");
    click(pro);
    expect(posted).toHaveLength(2);
  });

  it("outlines the parts waiting in the composer with their numbers, only on the parent's word, and never picks an outline", () => {
    const { say } = boot();
    const outlines = () => Array.from(document.querySelectorAll("[data-mausbot-point=mark]"), (mark) => mark.textContent);
    say(marksMessage(["#plans > div:nth-of-type(1) > button", "#gone", "a:::bad", "footer > a"]), { name: "not the parent" });
    expect(outlines()).toEqual([]);
    say(marksMessage(["#plans > div:nth-of-type(1) > button", "#gone", "a:::bad", "footer > a"]));
    expect(outlines()).toEqual(["1", "4"]);
    say(pointMessage(true));
    const mark = document.querySelector("[data-mausbot-point=mark]")!;
    mark.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted).toEqual([]);
    say(marksMessage([]));
    expect(outlines()).toEqual([]);
  });

  it("hides an outline whose part has no box, and moves it when the page moves the part", async () => {
    const { say } = boot();
    const target = document.querySelector("footer > a")!;
    let rect = { left: 0, top: 0, width: 0, height: 0 };
    target.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => rect }) as DOMRect;
    say(marksMessage(["footer > a"]));
    const mark = document.querySelector<HTMLElement>("[data-mausbot-point=mark]")!;
    expect(mark.style.display).toBe("none");
    rect = { left: 10, top: 40, width: 50, height: 20 };
    document.querySelector("main")!.insertAdjacentHTML("afterbegin", "<p>opened</p>");
    await new Promise((done) => setTimeout(done, 0));
    await new Promise((done) => requestAnimationFrame(() => done(null)));
    expect([mark.style.display, mark.style.top, mark.style.height]).toEqual(["block", "40px", "20px"]);
  });

  it("keeps a space between a badge and the words after it, so the chip label reads as the page does", () => {
    const { say } = boot();
    document.body.innerHTML = `<div class="card"><span style="display:inline-block">Cloud</span>Restore <b>fin</b>ishes<script>ignored()</script>
      <i style="visibility:hidden">tooltip</i><details><summary>More</summary>folded</details></div>`;
    say(pointMessage(true));
    click(document.querySelector(".card")!);
    expect(posted.at(-1)).toMatchObject({ params: { tag: "div", text: "Cloud Restore finishes More" } });
  });

  it("keeps the page's capitals, a visible child of a hidden wrapper, and leaves out text the page does not render", () => {
    const { say } = boot();
    document.body.innerHTML = `<div class="card"><span style="text-transform:uppercase">save</span>
      <span style="visibility:hidden">tip <em style="visibility:visible">shown</em></span><details><summary>One</summary><summary>Two</summary>x</details>
      <section style="content-visibility:hidden">skipped</section></div>`;
    say(pointMessage(true));
    click(document.querySelector(".card")!);
    expect(posted.at(-1)).toMatchObject({ params: { tag: "div", text: "SAVE shown One" } });
  });

  it("capitalizes a word once when it spans inline tags, and never picks a hovered part the page removed", () => {
    const { say } = boot();
    document.body.innerHTML = `<p class="cap" style="text-transform:capitalize"><b>w</b>ord <i>two</i>words</p><div id="gone">Gone</div>`;
    say(pointMessage(true));
    click(document.querySelector(".cap")!);
    expect(posted.at(-1)).toMatchObject({ params: { tag: "p", text: "Word Twowords" } });
    say(pointMessage(true));
    const gone = document.querySelector("#gone")!;
    gone.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    gone.remove();
    window.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted).toHaveLength(1);
  });

  it("keeps a capital after leading punctuation and a hyphen, and names a closed select by its chosen option", () => {
    const { say } = boot();
    document.body.innerHTML = `<p class="cap" style="text-transform:capitalize">(note) <b>"</b>two foo-bar</p>
      <select id="plan"><option>Free</option><option selected>Pro</option></select>`;
    say(pointMessage(true));
    click(document.querySelector(".cap")!);
    expect(posted.at(-1)).toMatchObject({ params: { tag: "p", text: '(Note) "Two Foo-Bar' } });
    say(pointMessage(true));
    click(document.querySelector("#plan")!);
    expect(posted.at(-1)).toMatchObject({ params: { tag: "select", text: "Pro" } });
  });

  it("names a keyed part by its key, and Escape ends point mode with word to the parent", () => {
    const { say } = boot();
    say(pointMessage(true));
    click(document.querySelector("[data-name=Pro] h2")!);
    expect(posted.at(-1)).toMatchObject({ params: { tag: "h2", role: "heading", selector: "#plans > div[data-name=\"Pro\"] > h2" } });
    say(pointMessage(true));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(posted.at(-1)).toEqual({ jsonrpc: "2.0", method: POINT_ENDED_METHOD, params: {} });
    click(document.querySelector("a")!);
    expect(posted).toHaveLength(2);
  });
});
