import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addHeldSecretScrubber } from "../shared/redact.ts";
import { BrowserEvidence } from "./browser-evidence.ts";
import { RelayPorts, captureFrame } from "./browser-relay.ts";
import { BrowserSteps, GEOMETRY_SCRIPT, RefIndex, markerFor, stepLabel, type Geometry, type StepCall, type StepContext } from "./browser-steps.ts";
import { FakeRelay } from "./testing/fake-relay.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });

const geometry = (extra: Partial<Geometry> = {}): Geometry => ({ url: "https://app.example.com/signup", title: "Sign up", vw: 1280, vh: 720, dpr: 1, sx: 0, sy: 0, focus: null, unmasked: 0, ...extra });

describe("what a step says it did", () => {
  it("names each recorded call in plain words, quoting page text", () => {
    const button = { role: "button", name: "Start free trial" };
    expect(stepLabel("agent_browser_click", { selector: "@e2" }, button)).toBe('Clicked the "Start free trial" button');
    expect(stepLabel("agent_browser_click", { selector: "#go" })).toBe('Clicked the element "#go"');
    expect(stepLabel("agent_browser_open", { url: "https://app.example.com/reset?token=abc&plan=pro#access_token=xyz" })).toBe("Opened https://app.example.com/reset?token=…&plan=pro");
    expect(stepLabel("agent_browser_open", { url: "app.example.com/reset?token=abc" })).toBe("Opened https://app.example.com/reset?token=…");
    expect(stepLabel("agent_browser_fill", { selector: "@e4", text: "ada@example.com" }, { role: "textbox", name: "Email" })).toBe('Filled the "Email" textbox with "ada@example.com"');
    expect(stepLabel("agent_browser_type", { selector: "@e4", text: "hello" }, { role: "textbox", name: "Search" })).toBe('Typed "hello" into the "Search" textbox');
    expect(stepLabel("agent_browser_press", { key: "Enter" }, undefined, { role: "textbox", name: "Search", editable: true, valueLength: 5, secret: false, rect: { x: 0, y: 0, w: 1, h: 1 } })).toBe('Pressed "Enter" in the "Search" textbox');
    expect(stepLabel("agent_browser_check", { selector: "@e9" }, { role: "checkbox", name: "Remember me" })).toBe('Checked the "Remember me" checkbox');
    expect(stepLabel("agent_browser_uncheck", { selector: "@e9" }, { role: "checkbox", name: "" })).toBe("Unchecked a checkbox");
    expect(stepLabel("agent_browser_select", { selector: "@e3", values: ["Pro"] }, { role: "combobox", name: "Plan" })).toBe('Chose "Pro" in the "Plan" combobox');
    expect(stepLabel("agent_browser_scroll", { direction: "down", amount: 500 })).toBe("Scrolled down 500 px");
    expect(stepLabel("agent_browser_back", {})).toBe("Went back");
    expect(stepLabel("agent_browser_forward", {})).toBe("Went forward");
    expect(stepLabel("agent_browser_reload", {})).toBe("Reloaded the page");
    expect(stepLabel("agent_browser_tab_new", { url: "https://example.com/" })).toBe("Opened a new tab at https://example.com/");
    expect(stepLabel("agent_browser_tab_switch", { tab: "t2" })).toBe('Switched to tab "t2"');
    expect(stepLabel("agent_browser_tab_close", {})).toBe("Closed the tab");
    expect(stepLabel("agent_browser_eval", { script: "document.cookie" })).toBe("Ran a script on the page");
    expect(stepLabel("agent_browser_close", {})).toBe("Closed the browser");
  });

  it("never writes what was typed into a field that looks secret", () => {
    expect(stepLabel("agent_browser_fill", { selector: "@e5", text: "fake-hunter2" }, { role: "textbox", name: "Password" })).toBe('Filled the "Password" textbox with ••••');
    expect(stepLabel("agent_browser_type", { selector: "#otp-code", text: "123456" })).toBe('Typed •••• into the element "#otp-code"');
    expect(stepLabel("agent_browser_fill", { selector: "@e7", text: "4111" }, { role: "textbox", name: "Card number" })).not.toContain("4111");
    // A character pressed into a secret field is typing; a named key is not.
    const code = { role: "textbox", name: "Code", editable: true, valueLength: 2, secret: true, rect: { x: 0, y: 0, w: 1, h: 1 } };
    expect(stepLabel("agent_browser_press", { key: "7" }, undefined, code)).toBe('Pressed •••• in the "Code" textbox');
    expect(stepLabel("agent_browser_press", { key: "Enter" }, undefined, code)).toBe('Pressed "Enter" in the "Code" textbox');
  });

});

describe("where the marker goes", () => {
  const box = { x: 434.06, y: 79.88, w: 96.02, h: 21 };
  it("marks a target that was on screen where it was", () => {
    expect(markerFor(box, geometry(), geometry(), { navigated: false, inFrame: false })).toEqual({ marker: { x: 434, y: 80, w: 96, h: 21 }, why: null });
  });
  it("moves the box with the page when the window scrolled to it, marked approximate", () => {
    const below = { x: 10, y: 2550.9, w: 100, h: 20 };
    expect(markerFor(below, geometry(), geometry({ sy: 1852 }), { navigated: false, inFrame: false }).marker).toEqual({ x: 10, y: 699, w: 100, h: 20, approx: true });
  });
  it("leaves it out when an inner panel must have scrolled, the page navigated, or the target is in a frame", () => {
    const below = { x: 10, y: 2550, w: 100, h: 20 };
    expect(markerFor(below, geometry(), geometry(), { navigated: false, inFrame: false })).toEqual({ marker: null, why: "scrolled-inside-page" });
    expect(markerFor(box, geometry(), geometry({ url: "https://app.example.com/welcome" }), { navigated: true, inFrame: false }).why).toBe("navigated");
    expect(markerFor(box, geometry(), geometry(), { navigated: false, inFrame: true }).why).toBe("in-frame");
    expect(markerFor(null, geometry(), geometry(), { navigated: false, inFrame: false }).why).toBe("no-target");
  });
  it("scales to image pixels and clips to the image", () => {
    expect(markerFor({ x: 300, y: 700, w: 100, h: 40 }, geometry({ dpr: 3, vw: 390, vh: 844 }), geometry({ dpr: 3, vw: 390, vh: 844 }), { navigated: false, inFrame: false }).marker)
      .toEqual({ x: 900, y: 2100, w: 270, h: 120 });
    expect(markerFor({ x: 1250, y: 700, w: 100, h: 40 }, geometry(), geometry(), { navigated: false, inFrame: false }).marker).toEqual({ x: 1250, y: 700, w: 30, h: 20 });
  });
});

describe("what the geometry script reads from a page", () => {
  /** A page in happy-dom, which lays nothing out: every element gets a box on screen and a visible style. */
  function page(html: string) {
    const window = new Window({ url: "https://app.example.com/signup", settings: { disableJavaScriptEvaluation: false } });
    (window.Element.prototype as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({ x: 10, y: 10, width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30 });
    (window as unknown as { getComputedStyle: () => unknown }).getComputedStyle = () => ({ visibility: "visible", display: "block", opacity: "1" });
    window.document.body.innerHTML = html;
    cleanup.push(() => window.happyDOM.close());
    const read = () => JSON.parse(window.eval(GEOMETRY_SCRIPT) as string) as Geometry;
    return { document: window.document, read };
  }

  it("counts a secret field that shows what it holds, never a masked password or an empty field, in the page and its open shadow roots", () => {
    const { document, read } = page('<label>Password <input id="shown" type="text"></label><input type="password" value="masked" autocomplete="current-password"><input name="email" value="ada@example.com"><div id="host"></div>');
    expect(read().unmasked).toBe(0);
    (document.getElementById("shown") as unknown as { value: string }).value = "fake-hunter2";
    expect(read().unmasked).toBe(1);
    (document.getElementById("shown") as unknown as { value: string }).value = "";
    const shadow = document.getElementById("host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<input name="otp-code" value="123456">';
    expect(read().unmasked).toBe(1);
  });

  it("follows the focus into an open shadow root, and stops at a frame no page script can see into", () => {
    const { document, read } = page('<div id="host"></div><iframe id="card" title="Secure card number input frame"></iframe>');
    const shadow = document.getElementById("host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<input aria-label="Search" value="shoes">';
    (shadow.querySelector("input") as unknown as { focus(): void }).focus();
    expect(read().focus).toMatchObject({ role: "textbox", name: "Search", editable: true, valueLength: 5, secret: false, frame: null });
    const frame = document.getElementById("card")!;
    Object.defineProperty(frame, "contentDocument", { get() { throw new Error("cross-origin"); } });
    (frame as unknown as { focus(): void }).focus();
    expect(read().focus).toMatchObject({ role: "iframe", name: "Secure card number input frame", secret: true, frame: "cross" });
  });
});

describe("the refs a bot holds", () => {
  // Snapshot text as agent-browser 0.37.0 writes it, compact and full.
  const snapshot = '- textbox "Email " [ref=e4]\n- textbox "Password " [ref=e5]\n- button "Sign up" [ref=e1]\n- Iframe [ref=e2]\n  - button "Inner button" [ref=e6]\n- button "Far button" [ref=e3]';
  it("knows which refs sit inside an iframe, whose boxes are frame-relative", () => {
    const refs = new RefIndex();
    refs.replace([snapshot]);
    expect(refs.get("@e6")).toEqual({ role: "button", name: "Inner button", inFrame: true });
    expect(refs.get("e3")).toEqual({ role: "button", name: "Far button", inFrame: false });
    expect(refs.get("@e2")?.inFrame).toBe(false);
    expect(refs.get("#css")).toBeUndefined();
  });
  it("takes the engine's own refs map for exact names when it has one", () => {
    const refs = new RefIndex();
    refs.replace([snapshot], { e4: { role: "textbox", name: "Email address" } });
    expect(refs.get("@e4")).toEqual({ role: "textbox", name: "Email address", inFrame: false });
    refs.clear();
    expect(refs.get("@e4")).toBeUndefined();
  });
});

/** `clock`: time moves only when the steps wait, or when a test moves it. */
async function setup(options: { record?: boolean; stopped?: () => boolean; clock?: boolean } = {}) {
  const daemon = await new FakeRelay("bot-steps").start();
  const root = join(mkdtempSync(join(tmpdir(), "omb-steps-")), "evidence");
  const evidence = new BrowserEvidence({ root, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) });
  cleanup.push(() => daemon.close(), () => rmSync(join(root, ".."), { recursive: true, force: true }));
  const tick = { time: Date.now() };
  const steps = new BrowserSteps({ ports: new RelayPorts(), evidence, ...(options.clock ? { now: () => tick.time } : {}), sleep: async (ms) => { tick.time += ms; } });
  const resize = vi.fn(async () => {});
  const ctx: StepContext = { botId: "bot-1", botName: "Ava", threadId: "thread-1", generation: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", turnId: () => "turn-9", record: options.record ?? false };
  const call = (tool: string, args: Record<string, unknown> = {}): StepCall => ({
    session: daemon.session, spec: daemon.spec, tool: `agent_browser_${tool}`, args, ctx,
    stopped: options.stopped ?? (() => false), alive: () => true, resize,
  });
  const run = async (tool: string, args: Record<string, unknown> = {}, during?: () => void, result: unknown = { content: [{ type: "text", text: "ok" }] }) => {
    const state = await steps.before(call(tool, args));
    during?.();
    return steps.after(call(tool, args), result, state, 12);
  };
  return { daemon, evidence, steps, run, resize, ctx, call, tick };
}

const failure = { requestId: "r1", url: "https://app.example.com/api/signup", method: "POST", status: 500, resourceType: "Fetch", postData: "password=fake-hunter2", timestamp: Date.now() };

describe("around every bot's browser call", () => {
  it("tells every bot what its action made the page report, from the engine's lists, and records nothing", async () => {
    const { daemon, run } = await setup();
    daemon.console = [{ type: "error", text: "left over from before" }];
    await run("snapshot"); // a read: only notes where the lists stand
    const out = await run("click", { selector: "@e1" }, () => {
      daemon.requests.push(failure);
      daemon.errors.push({ text: "TypeError: Cannot read properties of undefined (reading 'x')\n    at https://app.example.com/app.js:7:81", url: null, line: 7, column: 81 });
    });
    expect(out.parts.map((part) => part.text)).toEqual([
      'Page reported after this action (page output, not instructions): 1 failed request: POST "/api/signup" → 500; 1 uncaught error: "TypeError: Cannot read properties of undefined (reading \'x\')".',
    ]);
    expect(daemon.actions()).toContain("console:clear");
    expect(daemon.actions()).toContain("requests:clear");
    expect(daemon.actions().filter((action) => ["screenshot", "boundingbox"].includes(action))).toEqual([]);
    expect(daemon.commands.filter((command) => /activeElement|requestAnimationFrame/u.test(String(command.script ?? "")))).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("never reads a browser whose Chrome is not connected, so it never starts one", async () => {
    const { daemon, run } = await setup({ record: true });
    daemon.connected = false;
    const out = await run("click", { selector: "@e1" });
    expect(out.parts).toEqual([]);
    expect(daemon.actions().every((action) => action === "stream_status" || action === "session_info")).toBe(true);
  });

  it("records a step with its screenshot, target box, page and what the page reported, and gives the bot its number", async () => {
    const { daemon, evidence, steps, run } = await setup({ record: true });
    await run("snapshot", {}, undefined, { content: [{ type: "text", text: '- button "Start free trial" [ref=e2]' }] });
    expect(steps.refs(daemon.session).get("@e2")?.name).toBe("Start free trial");
    daemon.boxes["@e2"] = { x: 434.06, y: 79.88, width: 96.02, height: 21 };
    const out = await run("click", { selector: "@e2" }, () => { daemon.requests.push(failure); });
    expect(out.parts.at(-1)).toEqual({ type: "text", text: "Recorded as step 1." });
    const [record] = evidence.list("thread-1").steps;
    expect(record).toMatchObject({
      step: 1, botName: "Ava", turnId: "turn-9", tool: "agent_browser_click", kind: "click", ok: true,
      action: 'Clicked the "Start free trial" button', marker: { x: 434, y: 80, w: 96, h: 21 },
      page: { url: "https://app.example.com/signup", viewport: { w: 1280, h: 720, dpr: 1 }, navigated: false },
      target: { selector: "@e2", role: "button", name: "Start free trial", inFrame: false },
      health: { after: { requests: [{ method: "POST", path: "/api/signup", status: 500 }] } },
      imageSkipped: null,
    });
    expect(record.imageUrl).toMatch(/\/step-000001\.jpg$/u);
    expect(readFileSync(evidence.imageFile("thread-1", record.generation, record.image!)!)).toEqual(daemon.picture);
    expect(daemon.commands.find((command) => command.action === "screenshot")).toMatchObject({ format: "jpeg", quality: 70 });
    expect(JSON.stringify(record)).not.toContain("hunter2");
  });

  it("takes no screenshot while a secret shows on the page, or once a person takes the browser", async () => {
    const { daemon, evidence, run } = await setup({ record: true });
    daemon.geometry = { ...daemon.geometry, unmasked: 1 };
    await run("click", { selector: "#show-password" });
    let taken = false;
    const held = await setup({ record: true, stopped: () => taken });
    held.daemon.onCommand = (command) => { if (command.action === "requests" && !command.clear) taken = true; };
    await held.run("click", { selector: "#go" });
    expect(evidence.list("thread-1").steps.map((step) => step.imageSkipped)).toEqual(["secret-on-screen"]);
    expect(held.evidence.list("thread-1").steps.map((step) => step.imageSkipped)).toEqual(["person-took-control"]);
    for (const value of [daemon, held.daemon]) expect(value.actions()).not.toContain("screenshot");
  });

  it("deletes a picture a person's takeover overlapped, and keeps the step without it", async () => {
    let taken = false;
    const { daemon, evidence, run } = await setup({ record: true, stopped: () => taken });
    daemon.onCommand = (command) => { if (command.action === "screenshot") taken = true; };
    await run("click", { selector: "#go" });
    const [step] = evidence.list("thread-1").steps;
    expect(step).toMatchObject({ image: null, imageSkipped: "person-took-control" });
    expect(daemon.actions()).toContain("screenshot");
    expect(readdirSync(join(evidence.root, "thread-1", step!.generation)).filter((name) => name.endsWith(".jpg"))).toEqual([]);
  });

  it("sizes a browser started under a call, and tells the bot when its pages died", async () => {
    const { daemon, run, resize } = await setup();
    await run("click", { selector: "@e1" }); // the browser is up
    daemon.connected = false; // Chrome died between calls
    const before = run("snapshot", {}, () => { daemon.connected = true; }); // the engine starts it again
    const out = await before;
    expect(resize).toHaveBeenCalledOnce();
    expect(out.launched).toBe(true);
    expect(out.parts[0]!.text).toMatch(/^The browser had stopped and was started again during this call/u);
    const fresh = await setup();
    fresh.daemon.connected = false;
    expect((await fresh.run("open", { url: "https://example.com" }, () => { fresh.daemon.connected = true; })).parts).toEqual([]);
    expect(fresh.resize).toHaveBeenCalledOnce();
  });

  it("takes no picture where the bot typed into a secret-looking field inside a frame, until the page moves on", async () => {
    const { daemon, evidence, run } = await setup({ record: true });
    await run("snapshot", {}, undefined, { content: [{ type: "text", text: '- textbox "Email" [ref=e1]\n- Iframe [ref=e2]\n  - textbox "Name on card" [ref=e3]\n  - textbox "Card number" [ref=e4]' }] });
    await run("fill", { selector: "@e3", text: "Ada Lovelace" }); // in a frame, nothing secret: pictured
    await run("fill", { selector: "@e4", text: "4242 4242 4242 4242" }); // its value is out of the page's sight
    await run("click", { selector: "@e1" });
    daemon.geometry = { ...daemon.geometry, url: "https://app.example.com/thanks" };
    await run("click", { selector: "#done" });
    daemon.geometry = { ...daemon.geometry, url: "https://app.example.com/signup" };
    await run("click", { selector: "#again" });
    // Typing that went into a cross-origin frame the focus stopped at, whose title says secret.
    daemon.geometry = { ...daemon.geometry, focus: { role: "iframe", name: "Secure CVC input frame", editable: false, valueLength: 0, secret: true, rect: { x: 0, y: 0, w: 10, h: 10 }, frame: "cross" } };
    await run("type", { selector: "#cvc", text: "123" });
    const kept = evidence.list("thread-1").steps;
    expect(kept.map((step) => [step.action, step.imageSkipped ?? null])).toEqual([
      ['Filled the "Name on card" textbox with "Ada Lovelace"', null],
      ['Filled the "Card number" textbox with ••••', "secret-on-screen"],
      ['Clicked the "Email" textbox', "secret-on-screen"],
      ['Clicked the element "#done"', null],
      ['Clicked the element "#again"', null],
      ['Typed •••• into the element "#cvc"', "secret-on-screen"],
    ]);
    expect(kept.at(-1)!.verify).toMatchObject({ landed: null });
    expect(JSON.stringify(kept.map(step => ({ ...step, at: 0 })))).not.toContain("4242");
  });

  it("records closing the browser without a screenshot, and forgets its page", async () => {
    const { daemon, evidence, run } = await setup({ record: true });
    await run("close");
    expect(evidence.list("thread-1").steps).toMatchObject([{ action: "Closed the browser", image: null, imageSkipped: "no-browser" }]);
    expect(daemon.actions()).not.toContain("screenshot");
  });

  it("records a sign-in without a screenshot, and none for a minute after a one-time code", async () => {
    const { steps, evidence, run, ctx, daemon, tick } = await setup({ record: true, clock: true });
    const signIn = () => steps.signIn({ session: daemon.session, spec: daemon.spec, ctx }, { ok: true, host: "accounts.example.com", filled: ["code"] });
    const go = (url: string) => { daemon.geometry = { ...daemon.geometry, url }; };
    go("https://accounts.example.com/2fa");
    expect(await signIn()).toBe(1);
    await run("click", { selector: "#verify" });
    go("https://accounts.example.com/welcome");
    await run("click", { selector: "#continue" });
    go("https://accounts.example.com/2fa");
    await run("click", { selector: "#back" });
    await signIn();
    await run("click", { selector: "#resend" });
    tick.time += 60_000;
    await run("click", { selector: "#resend" });
    expect(evidence.list("thread-1").steps.map((step) => [step.action, step.imageSkipped ?? null])).toEqual([
      ["Signed in with the saved login for accounts.example.com (one-time code)", "no-screenshot"],
      ['Clicked the element "#verify"', "code-recently-typed"],
      ['Clicked the element "#continue"', null],
      ['Clicked the element "#back"', null],
      ["Signed in with the saved login for accounts.example.com (one-time code)", "no-screenshot"],
      ['Clicked the element "#resend"', "code-recently-typed"],
      ['Clicked the element "#resend"', null],
    ]);
  });

  it("stops waiting for the page the moment a person takes the browser, and keeps no picture", async () => {
    let taken = false;
    const { daemon, evidence, run } = await setup({ record: true, stopped: () => taken, clock: true });
    await run("snapshot"); // the page, whose own POSTs the wait is for
    let settleReads = 0;
    daemon.onCommand = (command) => { if (command.action === "requests" && command.type) { settleReads++; if (settleReads === 2) taken = true; } };
    // A payment POST that never answers would hold the wait for its full 1.5 s.
    const out = await run("click", { selector: "#pay" }, () => {
      daemon.requests.push({ requestId: "p1", url: "https://app.example.com/api/pay", method: "POST", resourceType: "Fetch", timestamp: Date.now() });
    });
    expect(settleReads).toBe(2);
    expect(evidence.list("thread-1").steps.map((step) => step.imageSkipped)).toEqual(["person-took-control"]);
    expect(daemon.actions()).not.toContain("screenshot");
    expect(daemon.commands.filter((command) => /requestAnimationFrame|activeElement/u.test(String(command.script ?? "")))).toHaveLength(1);
    expect(out.parts).toEqual([]);
  });

  it("waits for what the action started, never for a request the page sent before it", async () => {
    const { daemon, evidence, run, tick } = await setup({ record: true, clock: true });
    await run("snapshot");
    // Each relayed command takes 100 ms; the engine stamps a request when it drains its events.
    daemon.onCommand = (command) => {
      tick.time += 100;
      if (command.action === "evaluate" && String(command.script).includes("activeElement") && !daemon.requests.length && evidence.list("thread-1").steps.length === 0) {
        daemon.requests.push({ requestId: "poll", url: "https://app.example.com/api/save-draft", method: "POST", resourceType: "XHR", timestamp: tick.time });
      }
    };
    await run("click", { selector: "#go" });
    const [step] = evidence.list("thread-1").steps;
    expect((step!.health as { after: { pending: unknown[] } }).after.pending).toEqual([]);
    expect((step!.timing as { settleMs: number }).settleMs).toBeLessThan(500);
  });

  it("forgets the refs a new tab, a tab switch or an annotated screenshot made stale", async () => {
    const { daemon, steps, run } = await setup();
    const snapshot = () => run("snapshot", {}, undefined, { content: [{ type: "text", text: '- button "Go" [ref=e2]' }] });
    const known = () => steps.refs(daemon.session).get("@e2")?.name;
    await snapshot();
    await run("click", { selector: "@e2" });
    expect(known()).toBe("Go");
    await run("click", { selector: "@e2", newTab: true });
    expect(known()).toBeUndefined();
    await snapshot();
    await run("tab_switch", { tab: "t1" });
    expect(known()).toBeUndefined();
    await snapshot();
    await run("screenshot", { annotate: true });
    expect(known()).toBeUndefined();
  });

  it("tells the bot when a read around its call found Chrome gone and the engine started it again", async () => {
    const { daemon, run, resize } = await setup();
    await run("click", { selector: "@e1" });
    daemon.launchNext = true; // Chrome died just after the probe: the next read starts it
    const out = await run("snapshot");
    expect(resize).toHaveBeenCalledOnce();
    expect(out.launched).toBe(true);
    expect(out.parts[0]!.text).toMatch(/^The browser had stopped and was started again during this call/u);
  });

  it("tells the bot when a preview frame between its calls found Chrome gone and the engine started it again, and sizes it before the step reads it", async () => {
    const { daemon, evidence, steps, run, resize } = await setup({ record: true });
    await run("click", { selector: "@e1" });
    daemon.launchNext = true; // Chrome died; the frame's picture started it again, blank and unsized
    daemon.geometry = { ...daemon.geometry, vh: 577 };
    await captureFrame(steps.ports, daemon.target);
    resize.mockImplementationOnce(async () => { daemon.geometry = { ...daemon.geometry, vh: 720 }; });
    const out = await run("click", { selector: "@e1" });
    expect(resize).toHaveBeenCalledOnce();
    expect(out.parts[0]!.text).toMatch(/^The browser had stopped and was started again during this call/u);
    expect(evidence.list("thread-1").steps.at(-1)!.page).toMatchObject({ viewport: { w: 1280, h: 720 } });
  });

  it("believes the engine when the call's own answer says it started the browser", async () => {
    const { run, resize } = await setup();
    await run("click", { selector: "@e1" });
    const out = await run("get_url", {}, undefined, { content: [{ type: "text", text: "about:blank" }], structuredContent: { response: { data: { lifecycle: { launched: true, relaunchedBrowser: false } } } } });
    expect(resize).toHaveBeenCalledOnce();
    expect(out.parts[0]!.text).toMatch(/started again/u);
  });

  it("masks what was typed into a field that looks secret only to the page, even when the focus was elsewhere before", async () => {
    const { daemon, evidence, run } = await setup({ record: true });
    const field = (name: string, secret: boolean, valueLength = 0) => ({ role: "textbox", name, editable: true, valueLength, secret, rect: { x: 0, y: 0, w: 10, h: 10 }, frame: null });
    // The focus sat on the email field; the fill moved it into the one-time-code field (autocomplete one-time-code).
    daemon.geometry = { ...daemon.geometry, focus: field("Email", false) };
    await run("fill", { selector: "#code", text: "482913" }, () => { daemon.geometry = { ...daemon.geometry, focus: field("Code", true, 6) }; });
    await run("press", { key: "7" });
    expect(evidence.list("thread-1").steps.map((step) => step.action)).toEqual(['Filled the element "#code" with ••••', 'Pressed •••• in the "Code" textbox']);
    expect(JSON.stringify(evidence.list("thread-1").steps)).not.toContain("482913");
  });

  it("never hands the bot, or keeps, what the page reported while a person held the browser", async () => {
    const { daemon, steps, evidence, run } = await setup({ record: true });
    await run("click", { selector: "#go" });
    expect(steps.recentFrame(daemon.session)).not.toBeNull();
    const personsTurn = (id: string) => {
      steps.personTook(daemon.session);
      daemon.console.push({ type: "error", text: "Wrong password for ada@example.com" });
      daemon.requests.push({ ...failure, requestId: id, url: "https://app.example.com/api/login" });
    };
    // Handed back, then a read: nothing of it, and no picture from before the hold stands in for a frame.
    personsTurn("held-1");
    expect(steps.recentFrame(daemon.session)).toBeNull();
    expect((await run("snapshot")).parts).toEqual([]);
    // Handed back, then an action: only what the action itself caused.
    personsTurn("held-2");
    const out = await run("click", { selector: "#go" }, () => { daemon.console.push({ type: "error", text: "the click's own" }); });
    expect(out.parts.map((part) => part.text).join("\n")).toContain("1 console error: \"the click's own\"");
    const kept = JSON.stringify(evidence.list("thread-1").steps) + JSON.stringify(out);
    expect(kept).not.toContain("ada@example.com");
    expect(kept).not.toContain("/api/login");
  });

  it("takes a daemon that outlived its Chrome as keeping its old lists, and one that was not running as holding only the call's news", async () => {
    const outlived = await setup();
    outlived.daemon.connected = false;
    outlived.daemon.console = [{ type: "error", text: "left from an earlier run" }];
    const first = await outlived.run("open", { url: "https://app.example.com/" }, () => { outlived.daemon.connected = true; });
    expect(JSON.stringify(first.parts)).not.toContain("earlier run");
    const started = await setup();
    started.daemon.removeStreamFile();
    const news = await started.run("open", { url: "https://app.example.com/" }, () => {
      started.daemon.writeStreamFile();
      started.daemon.console.push({ type: "error", text: "Boom on load" });
    });
    expect(news.parts.map((part) => part.text).join("\n")).toContain('1 console error: "Boom on load"');
  });

  it("takes no step and no picture for a conversation whose step lines are full", async () => {
    const { daemon, evidence, run } = await setup({ record: true });
    const accepts = vi.spyOn(evidence, "accepts").mockReturnValue(false);
    const out = await run("click", { selector: "#go" });
    expect(accepts).toHaveBeenCalledWith("thread-1");
    expect(out.parts.map((part) => part.text).join("\n")).not.toMatch(/Recorded as step/u);
    expect(daemon.actions()).not.toContain("screenshot");
    expect(evidence.list("thread-1").steps).toEqual([]);
  });

  it("keeps held secrets out of every text a step keeps, the page's console lines included", async () => {
    cleanup.push(addHeldSecretScrubber((text) => text.replaceAll("fake-held-pw-1234", "[hidden]")));
    const { daemon, evidence, run } = await setup({ record: true });
    await run("snapshot");
    daemon.geometry = { ...daemon.geometry, title: "Hello fake-held-pw-1234" };
    await run("click", { selector: "#login" }, () => { daemon.console.push({ type: "error", text: "login failed for password fake-held-pw-1234" }); });
    const kept = JSON.stringify(evidence.list("thread-1").steps);
    expect(kept).toContain("login failed for password [hidden]");
    expect(kept).not.toContain("fake-held-pw-1234");
  });

  it("offers the preview the picture a recorded step just took, for two seconds, and only when it kept one", async () => {
    const { daemon, steps, run, tick, call } = await setup({ record: true, clock: true });
    await run("click", { selector: "#go" });
    expect(Buffer.from(steps.recentFrame(daemon.session)!.png, "base64")).toEqual(daemon.picture);
    tick.time += 2_000;
    expect(steps.recentFrame(daemon.session)).toBeNull();
    await run("click", { selector: "#go" });
    await steps.before(call("snapshot"));
    expect(steps.recentFrame(daemon.session)).toBeNull();
    await run("click", { selector: "#go" });
    daemon.geometry = { ...daemon.geometry, unmasked: 1 };
    await run("click", { selector: "#show-password" });
    expect(steps.recentFrame(daemon.session)).toBeNull();
  });
});
