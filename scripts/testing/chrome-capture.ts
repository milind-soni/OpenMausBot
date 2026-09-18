// Headless-browser capture, on the browser this machine already has.
//
// The verification recipes that need a picture (scripts/verify-voice-ui.ts,
// scripts/capture-astra-ui.ts) drive Chrome over CDP through Node's built-in
// WebSocket, so no dependency joins the repo for a screenshot. A recipe owns
// its page; this module owns the browser, the session and the disposal, so a
// run cannot leave a window, a profile directory or a stray process behind.
//
// Set ASTRA_CAPTURE_CHROME to a Chromium binary to override the platform's
// usual install locations.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CaptureViewport {
  width: number;
  height: number;
}

/** 1280x900 is the app's own desktop layout; 2x keeps text readable. */
export const CAPTURE_VIEWPORT: CaptureViewport = { width: 1280, height: 900 };
export const CAPTURE_SCALE = 2;

const CHROME_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
  win32: [
    join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  ],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
};

export function chromeBinary(): string {
  const explicit = process.env.ASTRA_CAPTURE_CHROME?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`ASTRA_CAPTURE_CHROME does not exist: ${explicit}`);
    return explicit;
  }
  for (const candidate of CHROME_PATHS[process.platform] ?? []) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error("no Chrome found — set ASTRA_CAPTURE_CHROME to a Chromium binary to take these pictures");
}

export interface ChromeSession {
  child: ChildProcess;
  ws: string;
  profileDir: string;
  binary: string;
}

/** Launch headless Chrome with no window, no background network work and a
 * disposable profile, and wait for the CDP endpoint it prints on stderr. */
export async function launchChrome(
  viewport: CaptureViewport = CAPTURE_VIEWPORT,
  scale: number = CAPTURE_SCALE,
): Promise<ChromeSession> {
  const profileDir = await mkdtemp(join(tmpdir(), "astra-capture-"));
  const binary = chromeBinary();
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      `--force-device-scale-factor=${scale}`,
      `--window-size=${viewport.width},${viewport.height}`,
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const ws = await new Promise<string>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`Chrome printed no CDP endpoint within 30s: ${stderr.slice(-400)}`)),
      30_000,
    );
    timer.unref?.();
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited ${code} before its CDP endpoint appeared: ${stderr.slice(-400)}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { child, ws, profileDir, binary };
}
interface CdpSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

type CdpCall = <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>) => Promise<T>;

/** One attached page: navigate, evaluate, wait, photograph. */
export interface CdpPage {
  call: CdpCall;
  /** Navigate and resolve once the document is complete. */
  navigate(url: string, timeoutMs?: number): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  /** Poll `expression` until it is true; throws when it never becomes true. */
  waitFor(expression: string, timeoutMs: number, what: string): Promise<void>;
  /** Capture the viewport to a PNG file; resolves with its byte size. */
  shot(file: string): Promise<number>;
  close(): void;
}

export async function openCdpPage(
  session: Pick<ChromeSession, "ws">,
  viewport: CaptureViewport = CAPTURE_VIEWPORT,
  scale: number = CAPTURE_SCALE,
): Promise<CdpPage> {
  const { ws: wsUrl } = session;
  const Socket = (globalThis as { WebSocket?: new (url: string) => CdpSocket }).WebSocket;
  if (!Socket) throw new Error("this Node has no built-in WebSocket; Node 22+ is required for a CDP capture");
  const socket = new Socket(wsUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error(`could not open the CDP socket at ${wsUrl}`)));
  });
  socket.addEventListener("message", (event) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(String(event.data)) as typeof message;
    } catch {
      return; // a frame we cannot read is not a reply we are waiting for
    }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? "CDP error"));
    else entry.resolve(message.result);
  });
  const browserCall = async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    await opened;
    const id = nextId++;
    const reply = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return reply;
  };

  const created = (await browserCall("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const attached = (await browserCall("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  })) as { sessionId: string };
  const sessionId = attached.sessionId;
  const call = ((method: string, params: Record<string, unknown> = {}) =>
    browserCall(method, params, sessionId)) as CdpCall;
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: scale,
    mobile: false,
  });

  const evaluate = async <T,>(expression: string): Promise<T> => {
    const result = await call<{ result?: { value?: T } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result?.value as T;
  };

  return {
    call,
    evaluate,
    async navigate(url: string, timeoutMs = 120_000) {
      await call("Page.navigate", { url });
      for (let waited = 0; waited < timeoutMs; waited += 250) {
        if (await evaluate<boolean>("document.readyState === 'complete'")) return;
        await new Promise((done) => setTimeout(done, 250));
      }
      throw new Error(`the page never finished loading: ${url}`);
    },
    async waitFor(expression: string, timeoutMs: number, what: string) {
      for (let waited = 0; waited < timeoutMs; waited += 250) {
        if (await evaluate<boolean>(expression)) return;
        await new Promise((done) => setTimeout(done, 250));
      }
      throw new Error(`timed out waiting for ${what} (${timeoutMs}ms)`);
    },
    async shot(file: string) {
      const shot = await call<{ data: string }>("Page.captureScreenshot", { format: "png" });
      const bytes = Buffer.from(shot.data, "base64");
      writeFileSync(file, bytes);
      return bytes.length;
    },
    close() {
      socket.close();
    },
  };
}
/** Two frames of animation plus a beat, so a picture never catches a
 * half-painted surface. */
export const settle = (page: CdpPage) =>
  page.evaluate<null>(
    "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 200))))",
  );

/** Stop the browser and remove its profile. Chrome releases the directory a
 * moment after it exits, so this waits for the process rather than racing it —
 * removing it early leaves the profile behind in the OS temp root. */
export async function closeChrome(session: ChromeSession | undefined): Promise<void> {
  if (!session) return;
  session.child.kill();
  await new Promise<void>((done) => {
    const timer = setTimeout(done, 5_000);
    timer.unref?.();
    session.child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    if (session.child.exitCode !== null || session.child.signalCode !== null) {
      clearTimeout(timer);
      done();
    }
  });
  await rm(session.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
}

