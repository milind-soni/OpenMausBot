import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { openHeadlessChrome, type HeadlessPage } from "./testing/headless-chrome.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const work = mkdtempSync(join(tmpdir(), "omb-ws-browser-"));
const script = join(work, "replies.json");
const replies = ["WSNORMAL first paragraph.\n\nWSNORMAL second paragraph.", "WSRECOVER first paragraph that streams slowly.\n\nWSRECOVER second paragraph after reconnect.", "WSRETRY first paragraph.\n\nWSRETRY second paragraph."];
writeFileSync(script, JSON.stringify(Object.fromEntries(replies.map((reply, i) => [`probe${i}`, [{ say: reply }]]))));
const fixture = await launchVerificationServer({ FAKE_STREAM_SCRIPT: script, FAKE_STREAM_CADENCE: "2:50" }, undefined, undefined, undefined, undefined, undefined, [], undefined, resolve("dist"));
let page: HeadlessPage | undefined;
try {
  const { url, dataDir } = fixture.info;
  const api = fixtureApi(url);
  await api("PATCH", "/api/config", { language: "en" });
  const { bots } = await api("GET", "/api/bots");
  for (const bot of bots) if (bot.defaultBot) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
  const { bot } = await runControlOmb(["new-bot", "--name", "Socket demo", "--url", url]) as { bot: { id: string; threadId: string } };
  const selectedBot = (await api("GET", "/api/bots")).bots.find((entry: { id: string }) => entry.id === bot.id);
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["client"] });
  page = await openHeadlessChrome(join(dataDir, "chrome"));
  await page.send("Page.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    for (const key of ['omb-simple-mode-prompt','grok-move-2026-11','teams-2026-11b','whats-new-2026-11b','boat-credit-2026-11','omb-analytics-opt-out']) localStorage.setItem(key,'1');
    localStorage.setItem('omb-email-gate','skipped'); localStorage.setItem('omb-advanced-mode','true');
    window.feedAttempts=0; window.feedSockets=[]; window.feedEvents=[]; window.feedSse=[];
    const NativeSocket=WebSocket; window.WebSocket=class extends NativeSocket { constructor(url,...rest) {
      if (String(url).includes('/api/events')) window.feedAttempts++;
      if (sessionStorage.blockSocket === 'yes') throw new Error('Fixture blocked WebSocket');
      super(url,...rest); if(String(url).includes('/api/events')) { feedSockets.push(this); this.addEventListener('message',e=>feedEvents.push(JSON.parse(e.data))); }
    }};
    const NativeSse=EventSource; window.EventSource=class extends NativeSse { constructor(url,...rest) { super(url,...rest); if(String(url).includes('/api/events')) feedSse.push(this); }};
  ` });
  await page.send("Page.navigate", { url: `${url}/` });
  await page.until("document.querySelector('#pair-code')");
  assert.equal(await page.evaluate("feedAttempts + feedSse.length"), 0);
  await page.evaluate("document.querySelector('#pair-code').focus()");
  await page.send("Input.insertText", { text: pairing.code });
  await page.until("document.querySelector('#pair-code').form.querySelector('button[type=submit]:enabled')");
  await page.evaluate("document.querySelector('#pair-code').form.requestSubmit()");
  await page.until("feedEvents.some(e=>e.frame.kind==='hello')");
  async function selectBot() {
    await page!.until(`document.querySelector('[data-sidebar-bot-row="${bot.id}"]')`);
    await page!.evaluate(`document.querySelector('[data-sidebar-bot-row="${bot.id}"]').click()`);
    await page!.until(`document.querySelector('textarea[aria-label="Message Socket demo"]')`);
  }
  await selectBot();
  assert.equal(await page.evaluate("feedSockets.filter(s=>s.readyState===WebSocket.OPEN).length"), 1);
  assert.equal(await page.evaluate("feedSse.length"), 0);
  for (let i = 0; i < replies.length; i++) {
    if (i === 2) {
      await page.evaluate("sessionStorage.blockSocket='yes'; location.replace('/?liveTransport=sse')");
      await page.until("sessionStorage.blockSocket === 'yes' && feedAttempts >= 2");
      assert.equal(await page.evaluate("feedSse.length"), 0);
      assert.equal(await page.evaluate("feedSockets.length"), 0);
      await page.evaluate("delete sessionStorage.blockSocket");
      await page.until("feedEvents.some(e=>e.frame.kind==='hello')");
      await selectBot();
      assert.equal(await page.evaluate("feedSse.length"), 0);
    }
    await page.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="Message Socket demo"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'probe${i}'); field.dispatchEvent(new Event('input',{bubbles:true})); field.focus();})()`);
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    if (i === 1) {
      await page.until("document.querySelector('[role=log]')?.textContent.includes('WSRECOVER')");
      assert.equal(await page.evaluate(`(() => {
        const text = document.querySelector('[role=log]')?.textContent ?? '';
        feedSockets.at(-1).close();
        return text.includes('WSRECOVER') && !text.includes('WSRECOVER second paragraph after reconnect.');
      })()`), true, "the socket closed while the reply was streaming");
      await page.until("feedSockets.length >= 2 && feedEvents.some(e=>e.frame.kind==='hello' && e.frame.resumed)");
    }
    await runControlOmb(["wait", "--bot", bot.id, "--timeout", "60", "--url", url]);
    const { messages } = await api("GET", `/api/threads/${selectedBot.threadId}/messages`);
    const prompts = messages.filter((m: { role: string; text?: string }) => m.role === "user" && m.text === `probe${i}`);
    assert.equal(prompts.length, 1);
    assert.equal(await page.evaluate(`document.querySelectorAll('[data-mid="${prompts[0].id}"]').length`), 1);
    const saved = messages.filter((m: { role: string; kind: string; text?: string }) => m.role === "bot" && m.kind === "text" && m.text?.includes(replies[i]!.split(" ")[0]!));
    assert.equal(saved.map((m: { text: string }) => m.text).join("\n\n"), replies[i]);
    await page.until(`document.querySelector('[role=log]')?.textContent.includes(${JSON.stringify(replies[i]!.split("\n\n")[1])})`);
    for (const message of saved) {
      await page.until(`document.querySelector('[data-mid="${message.id}"]')`);
      const rendered = await page.evaluate(`document.querySelector('[data-mid="${message.id}"]').textContent`);
      let end = 0;
      for (const paragraph of message.text.split("\n\n")) {
        const start = rendered.indexOf(paragraph);
        assert.ok(start >= end);
        assert.equal(rendered.indexOf(paragraph, start + 1), -1);
        end = start + paragraph.length;
      }
      assert.equal(await page.evaluate(`document.querySelectorAll('[data-mid="${message.id}"]').length`), 1);
    }
  }
  console.log("PASS: unpaired localhost showed pairing; paired browser delivered over WebSocket, replayed after disconnect and retried a blocked socket without SSE; stored replies match the UI and each user message was sent once.");
} finally {
  page?.close();
  if (page) await page.exited(5_000);
  await fixture.close();
  rmSync(work, { recursive: true, force: true });
}
