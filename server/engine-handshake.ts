import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { killCliTree, spawnCli } from "./procs.ts";

export const HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 1024 * 1024;

/** Null when `command args` answers an ACP `initialize` with a protocol version; otherwise what went wrong. Nothing is
 * opened beyond that: no session, no prompt. */
export function acpHandshake(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolveHandshake) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(command, [...args], { env, cwd: dirname(command), stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolveHandshake(error instanceof Error ? error.message : String(error));
      return;
    }
    let settled = false;
    let buffer = "";
    let stderr = "";
    const finish = (failure: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void killCliTree(child, 2_000).finally(() => resolveHandshake(failure));
    };
    const timer = setTimeout(() => finish("it did not answer the ACP handshake in time"), timeoutMs);
    timer.unref?.();
    child.once("error", (error) => finish(error.message));
    child.once("exit", (code) => {
      const said = stripVTControlCharacters(stderr).split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
      finish(said ? said.slice(0, 400) : `it stopped with exit code ${code} before the ACP handshake`);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_LINE_BYTES) return finish("it answered the ACP handshake with too much output");
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: unknown; result?: { protocolVersion?: unknown }; error?: { message?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id !== 1) continue;
        if (typeof message.result?.protocolVersion === "number") return finish(null);
        return finish(`it refused the ACP handshake${typeof message.error?.message === "string" ? `: ${message.error.message.slice(0, 200)}` : ""}`);
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
    })}\n`);
  });
}
