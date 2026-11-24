import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { openHeadlessChrome } from "./headless-chrome.ts";

export async function verifyWorkspacePanes(previewUrl: string, finishGate: string, evidence: string, longActivity: boolean, createFork: () => Promise<string>) {
  const profile = mkdtempSync(join(tmpdir(), "omb-pane-browser-"));
  const page = await openHeadlessChrome(profile);
  const element = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
  const click = async (expression: string) => {
    await page.until(expression);
    const { x, y } = await page.evaluate(`(() => { const b = (${expression}).getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2} })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  const button = (text: string) => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
  const row = (name: string) => element(`[data-thread-label][title="${name}"]`);
  const pane = (name: string) => `section[aria-label="${name}"]`;
  const stop = (name: string) => element(pane(name) + ' [aria-label="Stop this turn"]');
  const composer = (name: string) => element(pane(name) + " textarea");
  const botRow = (name: string) => `[...document.querySelectorAll("[data-sidebar-bot-row]")].find(e => e.innerText.startsWith(${JSON.stringify(name)}))`;
  const drag = async (source: string, target: string, across: number, down: number, highlight?: string) => {
    await page.until(source);
    await page.until(target);
    await page.evaluate(`window.nativeThreadDrag = false; document.addEventListener("dragstart", event => {
      window.nativeThreadDrag = event.isTrusted;
    }, { once: true, capture: true })`);
    const point = (expression: string, x: number, y: number) => page.evaluate(`(() => {
      const r = (${expression}).getBoundingClientRect(); return { x: r.left + r.width * ${x}, y: r.top + r.height * ${y} };
    })()`);
    const from = await point(source, 0.36, 0.5), to = await point(target, across, down);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, buttons: 1, button: "left", clickCount: 1 });
    for (let step = 1; step <= 12; step++) await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: from.x + (to.x - from.x) * step / 12, y: from.y + (to.y - from.y) * step / 12, button: "left", buttons: 1,
    });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x + 1, y: to.y, button: "left", buttons: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...to, button: "left", buttons: 1 });
    assert.equal(await page.evaluate("window.nativeThreadDrag"), true);
    if (highlight) {
      await page.until(`${target}?.querySelector('[data-drop-preview="${highlight}"]')`, 5000);
      if (highlight === "right") writeFileSync(evidence.replace(".png", "-drop.png"), await page.capture());
    }
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", clickCount: 1 });
  };
  const preset = async (name: string) => {
    await click(element('[aria-label="Pane layout"]'));
    await click(button(name));
    await page.until("!document.querySelector('[role=menu]')");
  };
  const key = async (key: string, code: number) => {
    for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", {
      type, key, code: key, windowsVirtualKeyCode: code, ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}),
    });
  };
  const type = async (name: string, text: string, send = true) => {
    await click(composer(name));
    await page.send("Input.insertText", { text });
    await page.until(`${composer(name)}?.value === ${JSON.stringify(text)}`);
    if (send) await key("Enter", 13);
  };
  const dialog = '[role="dialog"][aria-label]';
  const pickBot = async (from: string, owner: string, target: string) => {
    await click(element(pane(from) + ' [data-tour="bot-pill"]'));
    await page.until(`document.activeElement === ${element(dialog + " input")}`);
    await page.send("Input.insertText", { text: owner });
    await key("Enter", 13);
    await page.until(element(dialog + ` [aria-label="${owner} threads"]`));
    await click(element(dialog + ` button[title="${target}"]`));
    await page.until(`${element(pane(target))}?.hasAttribute("data-pane-focused")`);
  };
  const split = async (name: string, direction: string) => {
    await click(`${row(name)}?.querySelector('[data-thread-split-menu] button')`);
    await click(button(direction));
    await page.until(`${composer(name)} && document.activeElement === ${composer(name)}`);
  };
  const reply = (name: string, text: string) => `[...document.querySelectorAll(${JSON.stringify(pane(name) + ' [data-look="message-bot"] [data-citation-source]')})].some(node => node.innerText.startsWith("reply to:") && node.innerText.trimEnd().endsWith(${JSON.stringify(text)}))`;
  const first = "Triage Gmail", second = "Triage iCloud", third = "Website ideas", draft = "Keep this website idea";
  try {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1536, height: 960, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url: previewUrl });
    await click(button("Not now"));
    await click(element('[aria-label="Expand Pepper threads"]'));
    await click(row(first));
    await page.until(composer(first));
    await drag(row(second), element(pane(first)), 0.92, 0.5, "right");
    await page.until(composer(second));
    await type(first, "Summarize the Gmail inbox");
    await type(second, "Summarize the iCloud inbox");
    await page.until(`${stop(first)} && ${stop(second)}`);
    writeFileSync(finishGate, "");
    await page.until(`${reply(first, "Summarize the Gmail inbox")} && ${reply(second, "Summarize the iCloud inbox")}`);
    await page.until(`!${stop(first)} && !${stop(second)}`);
    unlinkSync(finishGate);
    await click(row(first));
    await page.until(`document.activeElement === ${composer(first)}`);
    await split(third, "Open below");
    if (longActivity) {
      const list = element(pane(third) + " .burger-layers");
      await page.until(`${list}?.children.length === 211 && ${list}.firstElementChild.clientHeight >= 32`);
      assert.equal(await page.evaluate(`(() => {
        const list = ${list}, section = list.closest('[data-pane-id]'), transcript = list.closest('.glass-scroller');
        const initial = transcript.scrollTop;
        list.scrollTop = list.scrollHeight;
        const last = list.lastElementChild.getBoundingClientRect(), bounds = list.getBoundingClientRect();
        return list.scrollTop > 0 && last.top >= bounds.top - 1 && last.bottom <= bounds.bottom + 1 &&
          transcript.scrollTop === initial && section.querySelector('textarea').getBoundingClientRect().bottom <= section.getBoundingClientRect().bottom;
      })()`), true);
    }
    await type(third, draft, false);
    await type(first, "Check Gmail again");
    await type(second, "Check iCloud again");
    await page.until(`${stop(first)} && ${stop(second)}`);
    await click(stop(second));
    await page.until(`${stop(first)} && !${stop(second)} && ${composer(third)}.value === ${JSON.stringify(draft)}`);
    const bounds = (name: string) => page.evaluate(`${element(pane(name))}.getBoundingClientRect().toJSON()`);
    const [a, b, c] = await Promise.all([bounds(first), bounds(second), bounds(third)]);
    assert.equal(a.x, c.x);
    assert.equal(a.bottom, c.y);
    assert.equal(a.right, b.x);
    assert.equal(c.bottom, b.bottom);
    for (const [orientation, keyName, code] of [["vertical", "ArrowRight", 39], ["horizontal", "ArrowDown", 40]] as const) {
      const divider = element(`[role=separator][aria-label="Resize panes"][aria-orientation=${orientation}]`);
      await page.evaluate(`${divider}.focus()`);
      await key(keyName, code);
      await page.until(`${divider}.getAttribute('aria-valuenow') === '55'`);
    }
    const vertical = element('[role=separator][aria-label="Resize panes"][aria-orientation=vertical]');
    const grip = await page.evaluate(`${vertical}.getBoundingClientRect().toJSON()`);
    const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 48, y, button: "left", buttons: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x - 48, y, button: "left" });
    await page.until(`Number(${vertical}.getAttribute('aria-valuenow')) < 55`);
    await click(composer(third));
    writeFileSync(evidence, await page.capture());
    writeFileSync(finishGate, "");
    await page.until(reply(first, "Check Gmail again"));
    assert.equal(await page.evaluate(reply(second, "Check iCloud again")), false);
    await click(element(`[aria-label="Close pane for ${first}"]`));
    await page.until(`document.querySelectorAll('[data-workspace-thread]').length === 2 && ${composer(third)}?.value === ${JSON.stringify(draft)}`);
    await click(element(`[aria-label="Close pane for ${second}"]`));
    await page.until(`!document.querySelector('[data-workspace-thread]') && ${composer(third)}?.value === ${JSON.stringify(draft)}`);
    await click(row(first));
    await page.until(reply(first, "Summarize the Gmail inbox"));
    unlinkSync(finishGate);
    await preset("Two rows");
    await drag(row(second), element("[data-empty-pane]"), 0.5, 0.5, "fill");
    await page.until(composer(second));
    await type(first, "Keep running through layout changes");
    await page.until(stop(first));
    await type(second, "Keep this draft while tiling", false);
    const retainsWork = `${stop(first)} && ${composer(second)}?.value === "Keep this draft while tiling"`;
    await preset("Two columns");
    await page.until(retainsWork);
    await preset("Two left, one right");
    await drag(row(third), element("[data-empty-pane]"), 0.5, 0.5, "fill");
    await page.until(composer(third));
    await preset("Four-pane grid");
    await drag(row("Reading list"), element("[data-empty-pane]"), 0.5, 0.5, "fill");
    await page.until(`document.querySelectorAll('[data-workspace-thread]').length === 4 && ${retainsWork}`);
    await click(element('[aria-label="Pane layout"]'));
    for (const smaller of ["columns", "rows", "stack"]) assert.equal(await page.evaluate(`${element('[data-menu-key="' + smaller + '"]')}.disabled`), true);
    await key("Escape", 27);
    await click(element('[aria-label="Actions for Miso"]'));
    await page.until(`(${button("Open beside")})?.disabled && (${button("Open below")})?.disabled`);
    await key("Escape", 27);
    await page.until(retainsWork);
    await drag(botRow("Miso"), element(pane(first)), 0.9, 0.4);
    assert.equal(await page.evaluate("document.querySelectorAll('[data-workspace-thread]').length"), 4);
    await page.until(retainsWork);
    writeFileSync(evidence.replace(".png", "-grid.png"), await page.capture());
    await click(element('[aria-label="Close pane for Reading list"]'));
    await preset("Four-pane grid");
    await page.evaluate(`${row("Reading list")}.focus()`);
    await key("ContextMenu", 93);
    await page.until("document.activeElement?.dataset.menuKey?.startsWith('slot:')");
    await key("Enter", 13);
    await page.until(`document.activeElement === ${composer("Reading list")} && ${retainsWork}`);
    const forkId = await createFork();
    for (const from of [second, first]) {
      await click(element(pane(from) + ' [aria-label="All threads"]'));
      await page.until(element(dialog + ' [aria-label="Pepper threads"] button[aria-current="true"]'));
      assert.equal(await page.evaluate(`${element(dialog)}.innerText.includes("Release notes")`), false);
      await click(element(dialog + ` [data-thread-choice="${forkId}"]`));
      const forkPane = element(`section[data-workspace-thread="${forkId}"]`);
      await page.until(`${forkPane}?.hasAttribute("data-pane-focused")`);
      const forkTitle = await page.evaluate(`${forkPane}.getAttribute("aria-label")`);
      await click(element(pane(forkTitle) + ' [data-tour="bot-pill"]'));
      await page.until(element(dialog + ' [aria-label="Bots"]'));
      assert.equal(await page.evaluate(`${element(dialog)}.innerText.includes("Launch team")`), false);
      await page.send("Input.insertText", { text: "Miso" });
      await key("ArrowDown", 40);
      await key("Enter", 13);
      await page.until(element(dialog + ' [aria-label="Miso threads"]'));
      assert.equal(await page.evaluate(`${element(dialog)}.querySelectorAll("[data-thread-choice]").length`), 1);
      assert.equal(await page.evaluate(`${forkPane}.hasAttribute("data-pane-focused")`), true);
      await key("ArrowLeft", 37);
      await page.until(element(dialog + ' [aria-label="Bots"]'));
      await key("Escape", 27);
      await page.until(`!${element(dialog)} && document.activeElement === ${element(pane(forkTitle) + ' [data-tour="bot-pill"]')}`);
      await pickBot(forkTitle, "Miso", "Release notes");
      await pickBot("Release notes", "Pepper", from);
    }
    await pickBot(second, "Pepper", first);
    await page.until(`document.querySelectorAll('[data-workspace-thread]').length === 4 && ${retainsWork}`);
    writeFileSync(finishGate, "");
    await page.until(reply(first, "Keep running through layout changes"));
    assert.equal(await page.evaluate(`${composer(second)}.value`), "Keep this draft while tiling");
    const before = await page.evaluate(`[...document.querySelectorAll("[data-sidebar-bot-row]")].map(e => e.innerText.split("\\n")[0])`);
    const misoFirst = before.indexOf("Miso") < before.indexOf("Pepper");
    await drag(botRow("Miso"), botRow("Pepper"), 0.4, misoFirst ? 0.85 : 0.15);
    await page.until(`(${botRow("Miso")}.getBoundingClientRect().y < ${botRow("Pepper")}.getBoundingClientRect().y) !== ${misoFirst}`);
    assert.equal(await page.evaluate("document.querySelectorAll('[data-workspace-thread]').length"), 4);
    console.log(JSON.stringify({ result: "passed", evidence }));
  } finally {
    page.close();
    await page.exited(5000);
    await removeTempDir(profile);
  }
}
