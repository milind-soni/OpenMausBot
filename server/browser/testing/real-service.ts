// The browser service on the real Chrome the driver's suites use (OMB_CDP_CHROME, or OMB_CDP_E2E=1 for the installed
// one): pages from a loopback fixture server, a calibrated identity, and a data folder of its own.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import { removeTempDir } from "../../testing/cleanup.ts";
import { LocalBackend } from "../backends.ts";
import { calibrateIdentity, chromeFingerprint, type CalibratedIdentity } from "../chrome/calibrate.ts";
import type { ScreenSpec } from "../chrome/flags.ts";
import { sandboxDisabled } from "../chrome/host-setup.ts";
import { CHROME, FIRST_LAUNCH_MS, HOST, testRoot } from "../cdp/testing/real-chrome.ts";
import { BrowserService, type BrowserServiceOptions, type BrowserTarget } from "../service.ts";

export type ToolResult = { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };

let calibrated: { fingerprint: string; identity: Promise<CalibratedIdentity> } | null = null;

/** Read again once Chrome updates itself in place, as the server's launcher does: a runner's Chrome can update mid-run. */
function identityOf(executablePath: string, sandbox: boolean): Promise<CalibratedIdentity> {
  const fingerprint = chromeFingerprint(executablePath);
  if (calibrated?.fingerprint !== fingerprint) {
    const identity = calibrateIdentity({ executablePath, host: HOST, tmpRoot: testRoot(), sandbox, handshakeTimeoutMs: FIRST_LAUNCH_MS });
    calibrated = { fingerprint, identity };
    identity.catch(() => { if (calibrated?.identity === identity) calibrated = null; });
  }
  return calibrated.identity;
}

export interface RealService {
  service: BrowserService;
  dataDir: string;
  call(target: BrowserTarget, name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** The answer's text, pictures as [image]. */
  text(result: ToolResult): string;
  /** A value from the page's isolated world, through the bot's own eval tool. */
  read<T>(target: BrowserTarget, expression: string): Promise<T>;
  /** The same, read by the test straight from the tab in front, so it works while a person holds the browser. */
  peek<T>(target: BrowserTarget, expression: string): Promise<T>;
  close(): Promise<void>;
}

export async function startService({ screen, egressPort, ...options }: Partial<BrowserServiceOptions> & { screen?: ScreenSpec; egressPort?: (key: string) => Promise<number | null> } = {}): Promise<RealService> {
  if (!CHROME) throw new Error("No Chrome to test with.");
  const executablePath = CHROME;
  const sandbox = !sandboxDisabled(process.env);
  await identityOf(executablePath, sandbox);
  const dataDir = mkdtempSync(join(testRoot(), "omb-browser-service-"));
  const backend = new LocalBackend({
    dataDir,
    host: HOST,
    binary: async () => ({ path: executablePath, identity: await identityOf(executablePath, sandbox) }),
    screen: async () => screen ?? { width: 1920, height: 1080, deviceScaleFactor: 1 },
    locale: () => "en-US",
    egressPort: egressPort ?? (async () => null),
    sandbox,
    handshakeTimeoutMs: FIRST_LAUNCH_MS,
  });
  const service = new BrowserService({ dataDir, backend: () => backend, maxRunning: 4, idleMs: () => 600_000, ...options });
  const call = (target: BrowserTarget, name: string, args: Record<string, unknown> = {}) =>
    service.agentRpc(target, "tools/call", { name, arguments: args }) as Promise<ToolResult>;
  const text = (result: ToolResult) => result.content.map((part) => part.text ?? `[${part.type}]`).join("\n");
  return {
    service,
    dataDir,
    call,
    text,
    async read<T>(target: BrowserTarget, expression: string): Promise<T> {
      const result = await call(target, "agent_browser_eval", { expression: `JSON.stringify(${expression})` });
      if (result.isError) throw new Error(text(result));
      return JSON.parse(JSON.parse(text(result).split("\n")[0]!) as string) as T;
    },
    async peek<T>(target: BrowserTarget, expression: string): Promise<T> {
      const tab = service.profiles().find((profile) => profile.key === target.key)?.active();
      if (!tab) throw new Error(`${target.key} has no page open`);
      return await tab.page.evaluate(expression, { world: "isolated" }) as T;
    },
    async close() {
      await service.closeAll();
      await removeTempDir(dataDir);
    },
  };
}

/** Polls until `check` holds, or fails with what it last saw. */
export async function until<T>(read: () => T | Promise<T>, check: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`still ${JSON.stringify(value)} after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Width and height from a JPEG's start-of-frame segment. */
export function jpegSize(data: Buffer): { width: number; height: number } {
  for (let at = 2; at + 9 < data.length;) {
    if (data[at] !== 0xff) return { width: 0, height: 0 };
    const marker = data[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xc2) return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
    at += 2 + data.readUInt16BE(at + 2);
  }
  return { width: 0, height: 0 };
}
