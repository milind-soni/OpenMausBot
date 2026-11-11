// One page of a headless Chrome in a throwaway profile, driven over the DevTools protocol, for the verify-* scripts that
// photograph a Vite preview.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const CHROME_PATH = process.env.OMB_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface HeadlessPage {
  send: (method: string, params?: object) => Promise<any>;
  /** The expression's value, awaited when it is a promise. */
  evaluate: (expression: string) => Promise<any>;
  /** Waits until `condition` (an expression) is true, or throws after `timeoutMs`. */
  until: (condition: string, timeoutMs?: number) => Promise<void>;
  /** A PNG of the page, or of `clip` in CSS pixels. */
  capture: (clip?: { x: number; y: number; width: number; height: number }) => Promise<Buffer>;
  close: () => void;
}

export async function openHeadlessChrome(profile: string): Promise<HeadlessPage> {
  const chrome = spawn(CHROME_PATH, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    await delay(100);
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]!.trim(); } catch {}
  }
  if (!port) { chrome.kill(); throw new Error("Chrome did not start"); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(targets.find((target) => target.type === "page")!.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let next = 0;
  const waiting = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const call = waiting.get(message.id);
    if (!call) return;
    waiting.delete(message.id);
    if (message.error) call.fail(new Error(message.error.message)); else call.done(message.result);
  };
  const send = (method: string, params: object = {}) => new Promise<any>((done, fail) => {
    const id = ++next;
    waiting.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
  return {
    send,
    evaluate,
    async until(condition, timeoutMs = 60_000) {
      const end = Date.now() + timeoutMs;
      while (!(await evaluate(`Boolean(${condition})`).catch(() => false))) {
        if (Date.now() > end) throw new Error(`${condition} never held (${await evaluate("document.querySelector('main')?.textContent?.slice(0, 120) ?? ''").catch(() => "")})`);
        await delay(250);
      }
    },
    async capture(clip) {
      const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      return Buffer.from(data, "base64");
    },
    close() { socket.close(); chrome.kill(); },
  };
}
