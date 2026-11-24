import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { openHeadlessChrome } from "./headless-chrome.ts";

export async function verifyWorkspacePanes(previewUrl: string, finishGate: string, evidence: string) {
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
  const key = async (key: string, code: number) => {
    for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key, windowsVirtualKeyCode: code });
  };
  const type = async (name: string, text: string, send = true) => {
    await click(composer(name));
    await page.send("Input.insertText", { text });
    await page.until(`${composer(name)}?.value === ${JSON.stringify(text)}`);
    if (send) await key("Enter", 13);
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
    await split(second, "Open beside");
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
    console.log(JSON.stringify({ result: "passed", evidence }));
  } finally {
    page.close();
    await page.exited(5000);
    await removeTempDir(profile);
  }
}
