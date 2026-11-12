import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { spawnCli, killCliTree } from "../procs.ts";
import { augmentedPath } from "../env-path.ts";

/** Bounded, read-only app-server connection. It never creates a thread or turn. */
export function readCodexUsage(cli: string, track: (child: ChildProcess) => () => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
    delete env.OPENAI_API_KEY;
    const child = spawnCli(cli, ["app-server"], { cwd: homedir(), env, stdio: ["pipe", "pipe", "pipe"] });
    const untrack = track(child);
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      untrack();
      killCliTree(child);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Usage read timed out")), 10_000);
    const send = (message: unknown) => child.stdin!.write(JSON.stringify(message) + "\n");
    child.stdin!.on("error", () => finish(new Error("Usage connection closed")));
    child.stderr!.on("data", () => {});
    let buffer = "";
    child.stdout!.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return finish(new Error("Usage response too large"));
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error("Usage read unavailable"));
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/rateLimits/read", params: {} });
        } else if (message.id === 2) {
          if (message.error) return finish(new Error("Usage read unavailable"));
          finish(undefined, message);
        }
      }
    });
    child.on("error", () => finish(new Error("Usage app unavailable")));
    child.on("close", () => finish(new Error("Usage connection ended")));
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "gerer-build-studio", version: "1" } } });
  });
}
