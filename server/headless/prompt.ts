import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import type { HeadlessIo } from "./output.ts";

/** A person can answer: both ends are a terminal. A pipe, CI or another agent is not. */
export function terminalPresent(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/** Asks on stderr, so stdout stays the command's result; only "y" or "yes" is a yes. */
export async function askOnTerminal(question: string, io: HeadlessIo): Promise<boolean> {
  const lines = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = await lines.question(`${question} [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } catch {
    io.err("");
    return false;
  } finally {
    lines.close();
  }
}

/** The person's own browser, through the platform's opener; the address is one argument, never a shell string. */
export function openInBrowser(url: string): Promise<boolean> {
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}
