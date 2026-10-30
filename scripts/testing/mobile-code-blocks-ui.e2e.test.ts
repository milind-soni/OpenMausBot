import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../control-omb.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1";
if (!enabled) console.log("skipping mobile code-block UI: set OMB_UI_E2E=1 for isolated browser qualification");

const snippets = [
  "  First plaintext block\n    Keep this indentation.\n\n",
  `const message = "${"a_long_value_".repeat(30)}";\nconsole.log(message);`,
  `unknown-language ${"unbroken".repeat(50)}\n  Preserve the second line.`,
  "No language was specified.\n  This belongs only to the fourth block.",
  "indented block\n  preserved second line",
];
const reply = [
  "These independent examples have their own controls.",
  `\`\`\`text\n${snippets[0]}\n\`\`\``,
  `\`\`\`typescript\n${snippets[1]}\n\`\`\``,
  `\`\`\`unrecognised-fixture-language\n${snippets[2]}\n\`\`\``,
  `\`\`\`\n${snippets[3]}\n\`\`\``,
  snippets[4].split("\n").map(line => `    ${line}`).join("\n"),
  "This neighboring prose must never be copied with a block.",
].join("\n\n");
const blocks = `Array.from(document.querySelectorAll('.chat-md > div')).filter(element => element.querySelector('pre') && element.querySelector('button[aria-pressed]'))`;

async function connect(url: string) {
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let next = 0;
  socket.addEventListener("message", event => {
    const value = JSON.parse(String(event.data));
    const waiting = pending.get(value.id);
    if (!waiting) return;
    pending.delete(value.id);
    if (value.error) waiting.reject(new Error(value.error.message));
    else waiting.resolve(value.result);
  });
  const rejectPending = () => {
    for (const waiting of pending.values()) waiting.reject(new Error("Fixture Chrome connection closed"));
    pending.clear();
  };
  socket.addEventListener("close", rejectPending);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Fixture Chrome connection timed out")); }, 20_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); socket.close(); reject(new Error("Fixture Chrome connection failed")); }, { once: true });
  });
  return {
    close() { rejectPending(); socket.close(); },
    request(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture Chrome ${method} timed out`)); }, 30_000);
        pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
  };
}

(enabled ? it : it.skip)("keeps each mobile text/code block copyable, wrappable and reachable without hover", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  let evidence: string | undefined;
  const receipts: Record<string, any> = { geometry: [], copied: [], wrapping: [], clipboard: "Chrome Clipboard API read/write after real pointer events; permission granted only to the isolated fixture origin; refusal stubbed afterward" };
  try {
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("This recipe needs the pinned Chrome for Testing");
    fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify([reply]) });
    evidence = process.env.OMB_MOBILE_BLOCKS_EVIDENCE_DIR || join(process.env.OMB_UI_EVIDENCE_DIR || dirname(fixture.info.logPath), "mobile-code-blocks");
    mkdirSync(evidence, { recursive: true });
    const save = () => writeFileSync(join(evidence!, "receipt.json"), JSON.stringify(receipts, null, 2));
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en" });
    const { bots } = await api("GET", "/api/bots");
    for (const bot of bots.filter((bot: { defaultBot?: unknown }) => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    const created = await runControlOmb(["new-bot", "--name", "Pepper", "--url", fixture.info.url]) as { bot: { id: string; activeTaskId: string } };
    preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__mobile-blocks.html", title: "Isolated mobile code blocks", logLevel: "warn" });
    const profile = join(fixture.info.dataDir, "chrome");
    mkdirSync(profile, { recursive: true });
    // A hosted Linux runner has no mouse, so headless Chrome there reports no hover and no pointer. These settings give
    // the page a fine, hovering pointer on every host. Any touch-emulation call, even one that turns it off, swaps in the
    // host's own pointer again, so the desktop pass below runs before touch emulation is ever touched.
    const mouse = "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2";
    chrome = spawn(tools.chrome, ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--password-store=basic", "--use-mock-keychain", mouse, "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
      env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: "ignore",
    });
    const portFile = join(profile, "DevToolsActivePort");
    await expect.poll(() => {
      if (chrome!.exitCode !== null || chrome!.signalCode !== null) throw new Error("Fixture Chrome exited before startup");
      return existsSync(portFile);
    }, { timeout: 30_000 }).toBe(true);
    const [port, endpoint] = readFileSync(portFile, "utf8").trim().split("\n");
    cdp = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const target = await cdp.request("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.request("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const request = (method: string, params: unknown = {}) => cdp!.request(method, params, sessionId);
    const evaluate = async (expression: string) => {
      const response = await request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };
    const screenshot = async (name: string) => {
      const shot = await request("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidence!, name), Buffer.from(shot.data, "base64"));
    };
    await request("Page.enable");
    await request("Runtime.enable");
    await request("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.request("Browser.grantPermissions", { origin: new URL(preview.previewUrl).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    await request("Page.navigate", { url: preview.previewUrl });
    await expect.poll(() => evaluate(`Boolean(document.querySelector('textarea[aria-label="Message Pepper"]'))`), { timeout: 120_000 }).toBe(true);
    await evaluate(`document.querySelector('textarea[aria-label="Message Pepper"]').focus()`);
    await request("Input.insertText", { text: "Show separate text and code examples" });
    await request("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await request("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    const settled = await runControlOmb(["wait", "--bot", created.bot.id, "--task", created.bot.activeTaskId, "--timeout", "60", "--url", fixture.info.url]);
    receipts.settled = settled;
    await expect.poll(() => evaluate(`${blocks}.length`), { timeout: 30_000 }).toBe(snippets.length);
    await expect.poll(() => evaluate(`${blocks}[1].querySelector('pre')?.classList.contains('shiki')`), { timeout: 30_000 }).toBe(true);
    receipts.highlighted = true;
    await evaluate(`window.fixtureClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard); true`);
    const geometry = () => evaluate(`(() => {
      const rect = element => { const r = element.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
      return { width:innerWidth, pageWidth:document.documentElement.scrollWidth, coarse:matchMedia('(pointer:coarse)').matches, hover:matchMedia('(hover:hover)').matches,
        blocks:${blocks}.map(card => ({ ...rect(card), buttons:Array.from(card.querySelectorAll('button')).map(button=>({ ...rect(button), label:button.getAttribute('aria-label'), text:button.textContent, visibleLabels:Array.from(button.querySelectorAll('span')).some(span=>span.getBoundingClientRect().width>4&&span.getBoundingClientRect().height>4&&getComputedStyle(span).visibility!=='hidden'), pressed:button.getAttribute('aria-pressed') })) })) };
    })()`);
    const tap = async (index: number, kind: "copy" | "wrap", touch = true) => {
      const selector = kind === "copy" ? `button[aria-label*="clipboard"],button[title="Could not copy"]` : "button[aria-pressed]";
      let position: { x: number; y: number; hit: boolean };
      await expect.poll(async () => {
        position = await evaluate(`(async () => { const card=${blocks}[${index}]; const button=card.querySelector(${JSON.stringify(selector)}); if(!button) throw new Error('Missing ${kind} control'); button.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'}); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); const before=button.getBoundingClientRect(); await new Promise(requestAnimationFrame); const r=button.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2; const stable=Math.abs(before.x-r.x)<0.25&&Math.abs(before.y-r.y)<0.25; return {x,y,hit:stable&&button.contains(document.elementFromPoint(x,y))}; })()`);
        return position.hit;
      }, { timeout: 10_000 }).toBe(true);
      if (touch) {
        await request("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: position!.x, y: position!.y }] });
        await request("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await request("Input.dispatchMouseEvent", { type: "mousePressed", x: position!.x, y: position!.y, button: "left", clickCount: 1 });
        await request("Input.dispatchMouseEvent", { type: "mouseReleased", x: position!.x, y: position!.y, button: "left", clickCount: 1 });
      }
    };
    for (const [width, height, touch] of [[1100, 900, false], [390, 844, true], [320, 740, true], [844, 390, true]] as const) {
      if (touch) await request("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      await request("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: touch });
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      await expect.poll(() => evaluate(`(async () => {
        const card=${blocks}[0]; card.scrollIntoView({behavior:'instant',block:'start'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const before=card.getBoundingClientRect(); await new Promise(requestAnimationFrame);
        const after=card.getBoundingClientRect();
        return after.top>=0&&after.top<innerHeight/2&&Math.abs(before.top-after.top)<0.25;
      })()`), { timeout: 10_000 }).toBe(true);
      await expect.poll(() => evaluate("innerWidth")).toBe(width);
      const layout = await geometry();
      receipts.geometry.push(layout);
      await screenshot(`${touch ? "touch" : "desktop"}-${width}.png`);
      save();
      expect(layout.pageWidth).toBeLessThanOrEqual(width);
      expect(layout.coarse).toBe(touch);
      expect(layout.hover).toBe(!touch);
      for (const card of layout.blocks) {
        expect(card.left).toBeGreaterThanOrEqual(0);
        expect(card.right).toBeLessThanOrEqual(width);
        for (const button of card.buttons) {
          expect(button.left).toBeGreaterThanOrEqual(card.left);
          expect(button.right).toBeLessThanOrEqual(card.right);
          expect(button.visibleLabels).toBe(true);
          if (touch) { expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44); }
        }
      }
      await tap(0, "copy", touch);
      await expect.poll(() => evaluate("navigator.clipboard.readText()")).toBe(snippets[0]);
    }
    await request("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await request("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    for (let index = 0; index < snippets.length; index++) {
      await tap(index, "copy");
      await expect.poll(() => evaluate("navigator.clipboard.readText()")).toBe(snippets[index]);
      receipts.copied.push({ index, text: await evaluate("navigator.clipboard.readText()") });
    }
    const wraps = () => evaluate(`${blocks}.map(card => card.querySelector('button[aria-pressed]').getAttribute('aria-pressed'))`);
    expect(await wraps()).toEqual(snippets.map(() => "false"));
    for (const index of [1, 2]) {
      await tap(index, "wrap");
      await expect.poll(wraps).toEqual(snippets.map((_, at) => at === index ? "true" : "false"));
      const wrapped = await evaluate(`(() => { const card=${blocks}[${index}]; const pre=card.querySelector('pre'); return {whiteSpace:getComputedStyle(pre).whiteSpace,client:pre.clientWidth,scroll:pre.scrollWidth,text:pre.textContent}; })()`);
      expect(wrapped.whiteSpace).toBe("pre-wrap");
      expect(wrapped.scroll).toBeLessThanOrEqual(wrapped.client + 1);
      expect(wrapped.text).toBe(snippets[index]);
      receipts.wrapping.push({ index, ...wrapped });
      await tap(index, "copy");
      expect(await evaluate("navigator.clipboard.readText()")).toBe(snippets[index]);
      await screenshot(`wrapped-${index}.png`);
      await tap(index, "wrap");
      await expect.poll(wraps).toEqual(snippets.map(() => "false"));
    }
    const feedbackLayout = () => evaluate(`(() => { const card=${blocks}[0]; const button=card.querySelectorAll('button')[2]; const c=card.getBoundingClientRect(), b=button.getBoundingClientRect(); return {height:c.height,buttonWidth:b.width,buttonHeight:b.height,left:b.left-c.left,top:b.top-c.top}; })()`);
    const beforeFeedback = await feedbackLayout();
    await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable:true,value:async()=>{throw new Error('fixture denial');} }); true`);
    await tap(0, "copy");
    await expect.poll(() => evaluate(`${blocks}[0].querySelector('[role="status"]')?.textContent`)).toBe("Could not copy");
    expect(await feedbackLayout()).toEqual(beforeFeedback);
    receipts.failureFeedback = true;
    await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable:true,value:window.fixtureClipboardWrite }); true`);
    await tap(0, "copy");
    await expect.poll(() => evaluate(`${blocks}[0].querySelector('[role="status"]')?.textContent`)).toBe("Copied");
    expect(await feedbackLayout()).toEqual(beforeFeedback);
    receipts.successFeedback = true;
    await expect.poll(() => evaluate(`${blocks}[0].querySelector('[role="status"]')?.textContent`), { timeout: 5_000 }).toBe("Copy");
    expect(await feedbackLayout()).toEqual(beforeFeedback);
    receipts.feedbackLayoutStable = true;
    await request("Emulation.setTouchEmulationEnabled", { enabled: false });
    await request("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`${blocks}[0].querySelector('button[aria-pressed]').focus(); true`);
    await request("Input.dispatchKeyEvent", { type:"keyDown", key:"Tab", code:"Tab", windowsVirtualKeyCode:9 });
    await request("Input.dispatchKeyEvent", { type:"keyUp", key:"Tab", code:"Tab", windowsVirtualKeyCode:9 });
    const focus = await evaluate(`(() => { const el=document.activeElement;return {label:el.getAttribute('aria-label'),visible:el.matches(':focus-visible'),outline:getComputedStyle(el).outlineStyle}; })()`);
    expect(focus.label).toBe("Download snippet as file");
    expect(focus.visible).toBe(true);
    expect(focus.outline).not.toBe("none");
    receipts.keyboardFocus = focus;
    receipts.completed = true;
    save();
    console.log(`Mobile code-block evidence: ${evidence}`);
  } finally {
    cdp?.close();
    if (chrome) await waitForExit(chrome, { signal: "SIGTERM" });
    const closed = await Promise.allSettled([preview?.close(), fixture?.close()]);
    if (evidence) {
      receipts.cleanup = { chromeExited: !chrome || chrome.exitCode !== null || chrome.signalCode !== null, serverExited: !fixture || fixture.child.exitCode !== null || fixture.child.signalCode !== null, dataRemoved: !fixture || !existsSync(fixture.info.dataDir) };
      writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipts, null, 2));
      expect(receipts.cleanup).toEqual({ chromeExited: true, serverExited: true, dataRemoved: true });
    }
    expect(closed.filter(result => result.status === "rejected")).toEqual([]);
  }
}, 360_000);
