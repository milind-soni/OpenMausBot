// S4 conformance on real Chrome: snapshots across frames and shadow roots,
// refs, and every action. Cases marked (t3) are T3 Code's
// ServerBrowserPage.test.ts, Copyright 2026 T3 Tools Inc., used under the MIT
// License (third_party/t3-code/LICENSE), rewritten for this driver.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { hostTimeout } from "../../testing/host-timeout.ts";
import type { CdpPage } from "./page.ts";
import { FixtureServer } from "./testing/fixtures.ts";
import { CHROME, forbiddenCommands, inPageWorld, startChrome, testRoot, type RunningChrome } from "./testing/real-chrome.ts";

const suite = CHROME ? describe : describe.skip;

suite("S4 snapshot, refs and actions on real Chrome", () => {
  let fx: FixtureServer;
  let run: RunningChrome;
  let page: CdpPage;
  let files: string;
  let pages = 0;

  beforeAll(async () => {
    fx = await FixtureServer.start();
    run = await startChrome("actions");
    page = await run.browser.waitForPage();
    files = mkdtempSync(join(testRoot(), "omb-cdp-files-"));
  }, hostTimeout(180_000));

  afterAll(async () => {
    await run?.close();
    await fx?.close();
    if (files) await removeTempDir(files);
  });

  async function open(html: string, on: CdpPage = page): Promise<string> {
    const url = fx.page(`/p${++pages}`, `<!doctype html><meta charset="utf-8"><title>p${pages}</title>${html}`);
    await on.navigate(url);
    return url;
  }

  function refOf(tree: string, role: string, name: string, index = 0): string {
    const lines = tree.split("\n").filter((line) => line.trimStart().startsWith(`- ${role} ${JSON.stringify(name)}`));
    const ref = /\[ref=(e\d+)\]/.exec(lines[index] ?? "")?.[1];
    if (!ref) throw new Error(`No ${role} "${name}" #${index} in:\n${tree}`);
    return ref;
  }

  const read = <T = unknown>(expression: string, on: CdpPage = page) => on.evaluate(expression) as Promise<T>;
  const repeatedRows = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>row ${i + 1}<button data-testid="delete-row" onclick="this.parentElement.remove()">delete</button></li>`).join("")}</ul>`;

  it("reads and fills fields in the page, a same-site frame, a cross-site frame and open and closed shadow roots", async () => {
    fx.page("/field", `<!doctype html><label>Field <input aria-label="${"FRAME"}"></label><script>document.querySelector("input").setAttribute("aria-label", location.hostname === "localhost" ? "Cross frame field" : "Same frame field")</script>`);
    await open(`<h1>Fields</h1><label for="name">Your name</label><input id="name">
      <iframe title="Same-site frame" src="/field"></iframe>
      <iframe title="Cross-site frame" src="${fx.crossSiteUrl("/field")}"></iframe>
      <div id="open"></div><div id="closed"></div>
      <script>
        document.getElementById("open").attachShadow({ mode: "open" }).innerHTML = '<input aria-label="Open shadow field">';
        window.closedRoot = document.getElementById("closed").attachShadow({ mode: "closed" });
        closedRoot.innerHTML = '<input aria-label="Closed shadow field">';
      </script>`);
    await page.waitFor({ text: "Field", timeoutMs: 5_000 });
    await page.waitFor({ ms: 300 });
    const { tree, frames } = await page.snapshot();
    expect(frames).toBe(3);
    expect(page.frames.all().filter((frame) => frame.session !== page.session)).toHaveLength(1);
    expect(tree).toMatch(/- iframe "Cross-site frame" \[ref=e\d+\]:\n {2}- text: Field\n {2}- textbox "Cross frame field" \[ref=e\d+\]/);
    const fields = ["Your name", "Same frame field", "Cross frame field", "Open shadow field", "Closed shadow field"];
    for (const field of fields) await page.fill({ ref: refOf(tree, "textbox", field) }, `${field} value`);
    const oopif = page.frames.all().find((frame) => frame.session !== page.session)!;
    expect(await read(`document.getElementById("name").value`)).toBe("Your name value");
    expect(await read(`document.querySelector("iframe").contentDocument.querySelector("input").value`)).toBe("Same frame field value");
    expect(await page.evaluate(`document.querySelector("input").value`, { frameId: oopif.id })).toBe("Cross frame field value");
    expect(await read(`document.getElementById("open").shadowRoot.querySelector("input").value`)).toBe("Open shadow field value");
    expect(await inPageWorld(() => page.evaluate("closedRoot.querySelector('input').value", { world: "page" }))).toBe("Closed shadow field value");
    const after = (await page.snapshot()).tree;
    for (const field of fields) expect(after).toContain(`textbox ${JSON.stringify(field)} [ref=${refOf(tree, "textbox", field)}] [value=${JSON.stringify(`${field} value`)}]`);
  });

  it("clicks the fifth repeated delete control without touching row one (t3)", async () => {
    await open(repeatedRows);
    const { tree } = await page.snapshot();
    expect(tree.split("\n").filter((line) => line.includes('button "delete"'))).toHaveLength(5);
    await page.click({ ref: refOf(tree, "button", "delete", 4) }, { timeoutMs: 1_000 });
    expect(await read(`[...document.querySelectorAll("li")].map((li) => li.textContent)`)).toEqual(["row 1delete", "row 2delete", "row 3delete", "row 4delete"]);
  });

  it("rejects ambiguous CSS controls without clicking any row (t3)", async () => {
    await open(repeatedRows);
    await expect(page.click({ selector: 'button[data-testid="delete-row"]' }, { timeoutMs: 1_000 })).rejects.toThrow(/strict mode violation/);
    expect(await read(`document.querySelectorAll("li").length`)).toBe(5);
  });

  it("does not retarget a removed ref to a replacement node (t3)", async () => {
    await open(`<button onclick="this.textContent='clicked'">original</button>`);
    const ref = refOf((await page.snapshot()).tree, "button", "original");
    await inPageWorld(() => page.evaluate(`document.body.innerHTML = '<button onclick="this.textContent=\\'clicked\\'">replacement</button>'`, { world: "page" }));
    await expect(page.click({ ref }, { timeoutMs: 300 })).rejects.toThrow(/no longer on the page|stale/);
    expect(await read(`document.querySelector("button").textContent`)).toBe("replacement");
  });

  it("rejects refs from another tab (t3)", async () => {
    await open("<button>same label</button>");
    const ref = refOf((await page.snapshot()).tree, "button", "same label");
    const other = await run.browser.newPage();
    try {
      await open("<button>same label</button>", other);
      await other.snapshot();
      await expect(other.click({ ref })).rejects.toThrow(/another tab/);
    } finally {
      await other.close();
    }
  });

  it("revokes refs on takeover and issues usable refs in the next snapshot (t3)", async () => {
    await open(`<button onclick="this.textContent='clicked'">continue</button>`);
    const ref = refOf((await page.snapshot()).tree, "button", "continue");
    page.invalidateRefs();
    await expect(page.click({ ref })).rejects.toMatchObject({ code: "stale-ref" });
    await page.click({ ref: refOf((await page.snapshot()).tree, "button", "continue") });
    expect(await read(`document.querySelector("button").textContent`)).toBe("clicked");
  });

  it("revokes refs after navigation even when labels are identical (t3)", async () => {
    await page.navigate("data:text/html,<button>continue</button>");
    const ref = refOf((await page.snapshot()).tree, "button", "continue");
    await page.navigate("data:text/html,<button>continue</button><p>new document</p>");
    await expect(page.click({ ref })).rejects.toMatchObject({ code: "stale-ref" });
  });

  it("keeps an element's ref across snapshots while the element lives", async () => {
    await open(`<button onclick="document.body.insertAdjacentHTML('beforeend', '<button>later</button>')">first</button>`);
    const ref = refOf((await page.snapshot()).tree, "button", "first");
    await page.click({ ref });
    const tree = (await page.snapshot()).tree;
    expect(refOf(tree, "button", "first")).toBe(ref);
    expect(Number(refOf(tree, "button", "later").slice(1))).toBeGreaterThan(Number(ref.slice(1)));
  });

  it.each(["aria-ref=e1", " aria-ref=e1", "@e1"])("does not let a raw ref skip validation (%s) (t3)", async (selector) => {
    await open("<button>continue</button>");
    await page.snapshot();
    page.invalidateRefs();
    await expect(page.click({ selector })).rejects.toMatchObject({ code: "stale-ref" });
  });

  it("refuses a selector chain that names a ref instead of running it", async () => {
    await open("<button>continue</button>");
    await expect(page.click({ selector: "css=body >> aria-ref=e1" })).rejects.toMatchObject({ code: "invalid-selector" });
  });

  it("keeps CSS selectors with an aria-ref attribute, or ref text in a quoted value (t3)", async () => {
    await open(`<button aria-ref="save" onclick="this.textContent='saved'">save</button><button data-example=" >> aria-ref=e1" onclick="this.textContent='kept'">keep</button>`);
    await page.click({ selector: 'button[aria-ref="save"]' });
    await page.click({ selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await read(`[...document.querySelectorAll("button")].map((b) => b.textContent)`)).toEqual(["saved", "kept"]);
  });

  it("right-clicks, double-clicks, hovers, selects, and drags like a pointer user (t3)", async () => {
    await open(`
      <style>#menu { position: absolute; display: none } #hover:hover + #menu { display: block }</style>
      <button id="target">target</button>
      <div id="hover">hover me</div><div id="menu">menu item</div>
      <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
      <div id="card" draggable="true">card</div><div id="lane" style="height:40px">lane</div>
      <p id="log"></p>
      <script>
        const log = (text) => (document.getElementById("log").textContent += text + ";");
        const target = document.getElementById("target");
        target.addEventListener("contextmenu", (event) => { event.preventDefault(); log("context"); });
        target.addEventListener("dblclick", () => log("dblclick"));
        document.getElementById("card").addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", "card"));
        for (const type of ["dragenter", "dragover"]) document.getElementById("lane").addEventListener(type, (event) => event.preventDefault());
        document.getElementById("lane").addEventListener("drop", (event) => log("drop:" + event.dataTransfer.getData("text/plain")));
      </script>`);
    await page.click({ selector: "#target" }, { button: "right" });
    await page.click({ selector: "#target" }, { clickCount: 2 });
    await page.hover({ selector: "#hover" });
    expect(await read(`getComputedStyle(document.getElementById("menu")).display`)).toBe("block");
    expect(await page.select({ selector: "#size" }, ["Large"])).toEqual({ selected: ["l"] });
    expect(await read(`document.getElementById("size").value`)).toBe("l");
    expect(await page.drag({ selector: "#card" }, { selector: "#lane" })).toMatchObject({ dropped: "html5" });
    expect(await read(`document.getElementById("log").textContent`)).toBe("context;dblclick;drop:card;");
    await expect(page.select({ selector: "#target" }, ["s"])).rejects.toMatchObject({ code: "not-editable" });
  });

  it("sends trusted pointer events with a real mouse's pressure", async () => {
    await open(`<button id="b" style="width:120px;height:40px">press</button><p id="log"></p><script>
      for (const type of ["pointerdown", "mousedown", "pointerup", "click"]) document.getElementById("b").addEventListener(type, (e) => document.getElementById("log").textContent += type + ":" + e.isTrusted + ":" + (e.pressure ?? "") + ";");
    </script>`);
    await page.click({ selector: "#b" });
    expect(await read(`document.getElementById("log").textContent`)).toBe("pointerdown:true:0.5;mousedown:true:;pointerup:true:0;click:true:0;");
  });

  it("waits for a covered element, names what covers it, and clicks once it is free", async () => {
    await open(`<button id="b" onclick="this.textContent='clicked'" style="position:absolute;left:20px;top:20px;width:100px;height:40px">go</button>
      <div id="veil" style="position:fixed;inset:0;background:rgba(0,0,0,.2)">loading</div>`);
    await expect(page.click({ selector: "#b" }, { timeoutMs: 400 })).rejects.toThrow(/covered by <div#veil> "loading"/);
    await inPageWorld(() => page.evaluate(`setTimeout(() => document.getElementById("veil").remove(), 300)`, { world: "page" }));
    await page.click({ selector: "#b" }, { timeoutMs: 3_000 });
    expect(await read(`document.getElementById("b").textContent`)).toBe("clicked");
  });

  it("clicks an element far down a scrolled page, and one inside a scrolled frame", async () => {
    fx.page("/tall-frame", `<!doctype html><div style="height:1500px"></div><button onclick="this.textContent='hit in frame'">deep in frame</button>`);
    await open(`<div style="height:2500px"></div><button id="far" onclick="this.textContent='hit'">far down</button><iframe src="${fx.crossSiteUrl("/tall-frame")}" style="height:200px"></iframe><div style="height:2000px"></div>`);
    await page.waitFor({ ms: 300 });
    const tree = (await page.snapshot()).tree;
    await page.click({ ref: refOf(tree, "button", "far down") });
    expect(await read(`document.getElementById("far").textContent`)).toBe("hit");
    await page.click({ ref: refOf(tree, "button", "deep in frame") });
    const frame = page.frames.all().find((candidate) => candidate.session !== page.session)!;
    expect(await page.evaluate(`document.querySelector("button").textContent`, { frameId: frame.id })).toBe("hit in frame");
  });

  it("waits for a disabled button to be enabled before clicking it", async () => {
    await open(`<button id="b" disabled onclick="this.textContent='clicked'">go</button><script>setTimeout(() => document.getElementById("b").disabled = false, 300)</script>`);
    await page.click({ selector: "#b" }, { timeoutMs: 3_000 });
    expect(await read(`document.getElementById("b").textContent`)).toBe("clicked");
  });

  it("returns from a click once it opens a dialog (t3)", async () => {
    await open(`<button onclick="document.body.dataset.answer = String(confirm('sure?'))">Confirm</button>`);
    const result = await page.click({ ref: refOf((await page.snapshot()).tree, "button", "Confirm") }, { timeoutMs: 1_000 });
    expect(result.dialog).toBe(true);
    expect(page.dialogs.pending).toMatchObject({ type: "confirm", message: "sure?" });
    await expect(page.snapshot()).rejects.toMatchObject({ code: "dialog-pending" });
    await page.answerDialog({ accept: true });
    await page.waitFor({ timeoutMs: 2_000, target: { selector: "body[data-answer=true]" } });
  });

  it("types with key events per character, Shift held for capitals, into the field or the focused one", async () => {
    await open(`<input id="a"><input id="b"><p id="log"></p><script>
      document.addEventListener("keydown", (e) => document.getElementById("log").textContent += e.key + (e.shiftKey ? "+shift" : "") + ":" + e.isTrusted + " ");
    </script>`);
    await page.type({ selector: "#a" }, "Hi!");
    await page.type(null, " there");
    expect(await read(`document.getElementById("a").value`)).toBe("Hi! there");
    expect(await read(`document.getElementById("log").textContent`)).toBe("Shift+shift:true H+shift:true i:true Shift+shift:true !+shift:true  :true t:true h:true e:true r:true e:true ");
    await page.fill({ selector: "#a" }, "replaced");
    expect(await read(`document.getElementById("a").value`)).toBe("replaced");
    await page.fill({ selector: "#a" }, "");
    expect(await read(`document.getElementById("a").value`)).toBe("");
  });

  it("targets iframe input refs and preserves the parent form (t3)", async () => {
    await open(`<input aria-label="parent"><iframe srcdoc="<input aria-label=child>"></iframe>`);
    await page.waitFor({ ms: 200 });
    const tree = (await page.snapshot()).tree;
    await page.type({ ref: refOf(tree, "textbox", "child") }, "inside iframe");
    expect(await read(`document.querySelector("iframe").contentDocument.querySelector("input").value`)).toBe("inside iframe");
    expect(await read(`document.querySelector("input").value`)).toBe("");
  });

  it("refuses to type into what is not an enabled text field (t3)", async () => {
    await open(`<button id="b">b</button><input id="d" disabled><input id="r" readonly value="x"><input id="c" type="checkbox">`);
    for (const selector of ["#b", "#d", "#r", "#c"]) {
      await expect(page.fill({ selector }, "x")).rejects.toThrow("The target is not an enabled text field, so no text was typed.");
    }
    await inPageWorld(() => page.evaluate("document.activeElement.blur()", { world: "page" }));
    await expect(page.type(null, "x")).rejects.toMatchObject({ code: "not-editable" });
  });

  it("fills date and time fields the way a picker would, and edits contenteditable", async () => {
    await open(`<input id="d" type="date"><div id="e" contenteditable="true">old text</div>`);
    await page.fill({ selector: "#d" }, "2026-10-15");
    expect(await read(`document.getElementById("d").value`)).toBe("2026-10-15");
    await page.fill({ selector: "#e" }, "new text");
    expect(await read(`document.getElementById("e").textContent`)).toBe("new text");
  });

  it("presses Enter to submit, and chords to select all", async () => {
    await open(`<form onsubmit="event.preventDefault(); document.body.dataset.sent = document.getElementById('q').value"><input id="q" value="keep"></form>`);
    await page.click({ selector: "#q" });
    await page.press("ControlOrMeta+A");
    expect(await read(`[document.getElementById("q").selectionStart, document.getElementById("q").selectionEnd]`)).toEqual([0, 4]);
    await page.press("End");
    await page.type(null, "s");
    await page.press("Enter");
    expect(await read(`document.body.dataset.sent`)).toBe("keeps");
  });

  it("selects several options in a multiple list and refuses one that is not there", async () => {
    await open(`<select id="m" multiple><option value="a">Apple</option><option value="b">Banana</option><option value="c">Cherry</option></select>
      <select id="dup"><option value="1">Same</option><option value="2">Same longer</option></select>`);
    expect(await page.select({ selector: "#m" }, ["a", "Cherry"])).toEqual({ selected: ["a", "c"] });
    await expect(page.select({ selector: "#m" }, ["Durian"])).rejects.toMatchObject({ code: "not-found" });
    expect(await page.select({ selector: "#dup" }, ["Same longer"])).toEqual({ selected: ["2"] });
  });

  it("checks and unchecks a checkbox, and refuses to uncheck a radio", async () => {
    await open(`<label><input id="c" type="checkbox"> remember</label><label><input id="r" type="radio" name="g"> one</label><div id="s" role="switch" aria-checked="false" tabindex="0" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true')">switch</div>`);
    expect(await page.check({ selector: "#c" })).toEqual({ checked: true, changed: true });
    expect(await page.check({ selector: "#c" })).toEqual({ checked: true, changed: false });
    expect(await page.check({ selector: "#c" }, false)).toEqual({ checked: false, changed: true });
    expect(await page.check({ selector: "#r" })).toEqual({ checked: true, changed: true });
    await expect(page.check({ selector: "#r" }, false)).rejects.toThrow(/cannot be unchecked/);
    expect(await page.check({ selector: "#s" })).toEqual({ checked: true, changed: true });
    const tree = (await page.snapshot()).tree;
    expect(tree).toMatch(/- checkbox "remember" \[ref=e\d+\]\n/);
    expect(tree).toMatch(/- radio "one" \[checked\] \[ref=e\d+\]/);
    expect(tree).toMatch(/- switch "switch" \[checked\] \[ref=e\d+\]/);
  });

  it("drags with a pressed mouse where the page tracks the mouse itself", async () => {
    await open(`<div id="track" style="position:absolute;left:20px;top:50px;width:400px;height:20px;background:#ddd"><div id="thumb" style="position:absolute;left:0;top:0;width:20px;height:20px;background:#333"></div></div>
      <script>
        const thumb = document.getElementById("thumb");
        let down = false;
        thumb.addEventListener("mousedown", () => down = true);
        addEventListener("mousemove", (e) => { if (down) thumb.style.left = Math.max(0, Math.min(380, e.clientX - 30)) + "px"; });
        addEventListener("mouseup", () => { down = false; document.body.dataset.left = thumb.style.left; });
      </script>`);
    expect(await page.drag({ selector: "#thumb" }, { x: 330, y: 60 })).toMatchObject({ dropped: "mouse" });
    expect(await read(`document.body.dataset.left`)).toBe("300px");
  });

  it("scrolls the page and an inner element with the mouse wheel", async () => {
    await open(`<div id="inner" style="height:100px;width:300px;overflow:auto"><div style="height:1000px">inner</div></div><div style="height:3000px">tall</div>`);
    await page.scroll({ selector: "#inner" }, 0, 300);
    await page.waitFor({ ms: 100 });
    expect(await read(`document.getElementById("inner").scrollTop`)).toBeGreaterThan(0);
    expect(await read(`scrollY`)).toBe(0);
    // Chrome keeps sending a quick second wheel to the element the first one scrolled, as it does for a person.
    await page.waitFor({ ms: 1_000 });
    await page.scroll(null, 0, 500);
    await page.waitFor({ ms: 100 });
    expect(await read(`scrollY`)).toBeGreaterThan(0);
  });

  it("uploads to a file input by ref and answers a picker the page opened", async () => {
    const one = join(files, "one.txt");
    const two = join(files, "two.txt");
    writeFileSync(one, "first file");
    writeFileSync(two, "second file");
    await open(`<input id="f" type="file" aria-label="Attachment"><input id="m" type="file" multiple aria-label="Many"><p id="names"></p>
      <script>for (const id of ["f", "m"]) document.getElementById(id).addEventListener("change", (e) => document.getElementById("names").textContent += [...e.target.files].map((f) => f.name + ":" + f.size).join(",") + ";");</script>`);
    await page.upload([one], { ref: refOf((await page.snapshot()).tree, "button", "Attachment") });
    await expect(page.upload([one, two], { selector: "#f" })).rejects.toThrow(/one file/);
    await expect(page.upload(["relative.txt"], { selector: "#f" })).rejects.toThrow(/absolute/);
    await expect(page.upload([one])).rejects.toThrow(/No file picker is open/);
    await page.click({ selector: "#m" });
    await page.upload([one, two]);
    expect(await read(`document.getElementById("names").textContent`)).toBe("one.txt:10;one.txt:10,two.txt:11;");
    await page.click({ selector: "#f" });
    expect(await page.fileChoosers.opened(2_000)).not.toBeNull();
    await open("<p>The page with the picker is gone.</p>");
    expect(page.fileChoosers.open).toBeNull();
  });

  it("finds elements by role and by text, strictly", async () => {
    await open(`<button>Save draft</button><button>Save</button><a href="#docs">Read the docs</a><p>Plain <span>words here</span></p>`);
    await page.click({ selector: 'role=button[name="Save"]' });
    await expect(page.click({ selector: "role=button[name*='save']" })).rejects.toMatchObject({ code: "ambiguous" });
    await page.click({ selector: "role=link[name*='docs']" });
    expect(await read("location.hash")).toBe("#docs");
    await page.hover({ selector: "text=words" });
    await expect(page.click({ selector: 'text="Save"' })).resolves.toBeDefined();
    await expect(page.click({ selector: "text=nothing like this" }, { timeoutMs: 200 })).rejects.toMatchObject({ code: "not-found" });
    await expect(page.click({ selector: "div[" })).rejects.toMatchObject({ code: "invalid-selector" });
  });

  it("masks passwords and codes in snapshots, and refuses eval and pictures while a filled secret is on the page", async () => {
    await open(`<form action="/after" method="get"><input aria-label="Email" value="a@example.com"><input aria-label="Password" type="password" value="hunter2-old"><input aria-label="One-time code" autocomplete="one-time-code" value="123456"><input aria-label="Notes"><input type="hidden" name="carry"><button>Sign in</button></form>`);
    fx.page("/after", "<!doctype html><title>after</title><p>signed in</p>");
    const tree = (await page.snapshot()).tree;
    expect(tree).toContain('textbox "Email"');
    expect(tree).toMatch(/textbox "Password" \[ref=e\d+\] \[value=••••\]/);
    expect(tree).toMatch(/textbox "One-time code" \[ref=e\d+\] \[value=••••\]/);
    expect(tree).not.toContain("hunter2");
    expect(tree).not.toContain("123456");
    await page.fillSecret({ ref: refOf(tree, "textbox", "Password") }, "correct horse battery");
    await page.fill({ ref: refOf(tree, "textbox", "Notes") }, "not a secret, but holds: correct horse battery");
    expect((await page.snapshot()).tree).not.toContain("correct horse battery");
    await expect(page.evaluate("1 + 1")).rejects.toMatchObject({ code: "secret-on-page" });
    await expect(page.screenshot()).rejects.toMatchObject({ code: "secret-on-page" });
    await expect(page.snapshot({ includeImage: true })).rejects.toMatchObject({ code: "secret-on-page" });
    await page.click({ ref: refOf(tree, "button", "Sign in") });
    await page.waitFor({ text: "signed in", timeoutMs: 5_000 });
    expect(await page.evaluate("1 + 1")).toBe(2);
    expect((await page.screenshot()).data.length).toBeGreaterThan(100);
  });

  it("sent nothing that enables Runtime, binds into pages or evaluates in the page's world uninvited", () => {
    expect(run.trace.length).toBeGreaterThan(100);
    expect(forbiddenCommands()).toEqual([]);
  });
});
