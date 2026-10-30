// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { APP_POINT_SOURCE, POINT_ENDED_METHOD, POINT_LIMITS, POINTED_METHOD, pointedLabel, pointMessage, readPointEvent } from "./point.ts";

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
  afterEach(() => { posted.length = 0; document.body.innerHTML = ""; document.documentElement.style.cursor = ""; });

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
    return { say };
  }
  const click = (element: Element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  it("describes the clicked element to its parent only while point mode is on, then turns itself off", () => {
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
    expect(document.documentElement.style.cursor).toBe("");
    click(pro);
    expect(posted).toHaveLength(1);
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
