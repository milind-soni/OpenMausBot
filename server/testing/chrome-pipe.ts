// A bare CDP client over --remote-debugging-pipe for tests that need a real Chrome: no debugging port to find or
// leave open, and a throwaway profile removed on close.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { credentialStoreFlags } from "../browser/egress/gate.ts";
import { removeTempDir } from "./cleanup.ts";

/** OMB_TEST_CHROME, CHROME_BIN, then where Google Chrome or Chromium installs on this platform. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  const installed = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : process.platform === "win32"
      ? [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].flatMap((root) => root ? [join(root, "Google", "Chrome", "Application", "chrome.exe")] : [])
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return [env.OMB_TEST_CHROME, env.CHROME_BIN, ...installed].find((path) => path && existsSync(path)) ?? null;
}

export interface ChromePage {
  navigate(url: string): Promise<{ errorText?: string }>;
  evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
  /** Waits until the page at `url` finished loading. */
  loaded(url: string, timeoutMs?: number): Promise<void>;
}

export interface PipeChrome {
  page(): Promise<ChromePage>;
  close(): Promise<void>;
}

export function chromeLaunchArgs(profile: string, args: string[], platform: NodeJS.Platform = process.platform): string[] {
  return [
    "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
    "--disable-sync", "--disable-features=Translate,OptimizationHints,MediaRouter",
    ...credentialStoreFlags(platform),
    // Ubuntu 23.10+ restricts the unprivileged user namespaces Chrome's sandbox needs; the sandbox is not under test here.
    ...(platform === "linux" ? ["--no-sandbox"] : []),
    ...args, "about:blank",
  ];
}

/** The test runner points HOME at a throwaway folder; Chrome gets the account's real one, where macOS keeps the
 * keychain it would otherwise put up a dialog to look for. */
export function chromeLaunchEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const home = userInfo().homedir;
  return { ...env, ...(platform === "win32" ? { USERPROFILE: home } : { HOME: home }) };
}

export async function launchPipeChrome(binary: string, args: string[]): Promise<PipeChrome> {
  const profile = mkdtempSync(join(tmpdir(), "omb-test-chrome-"));
  const child = spawn(binary, chromeLaunchArgs(profile, args), {
    env: chromeLaunchEnv(), stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { if (stderr.length < 8_192) stderr += String(chunk); });
  const toChrome = child.stdio[3] as Writable;
  const fromChrome = child.stdio[4] as Readable;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const events: Array<(message: { method?: string; params?: any; sessionId?: string }) => void> = [];
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  fromChrome.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    let end: number;
    while ((end = buffer.indexOf(0)) >= 0) {
      const message = JSON.parse(buffer.subarray(0, end).toString("utf8"));
      buffer = buffer.subarray(end + 1);
      const waiting = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (waiting) {
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
        else waiting.resolve(message.result);
      } else for (const listener of events) listener(message);
    }
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => {
    for (const waiting of pending.values()) waiting.reject(new Error(`Chrome exited: ${stderr}`));
    pending.clear();
    resolve();
  }));
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  await send("Browser.getVersion");
  return {
    async page() {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Page.enable", {}, sessionId);
      const evaluate = async <T>(expression: string, timeoutMs = 20_000): Promise<T> => {
        const answer = await Promise.race([
          send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`evaluate timed out: ${expression.slice(0, 80)}`)), timeoutMs).unref()),
        ]);
        if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails).slice(0, 500));
        return answer.result.value as T;
      };
      return {
        navigate: (url) => send("Page.navigate", { url }, sessionId),
        evaluate,
        async loaded(url, timeoutMs = 20_000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const ready = await evaluate<boolean>(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`).catch(() => false);
            if (ready) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error(`${url} did not load`);
        },
      };
    },
    async close() {
      await Promise.race([send("Browser.close").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await removeTempDir(profile);
    },
  };
}
