// Codex resolves its own effective account (keyring included): reading auth.json directly can label an
// API-key or keyring login with an old file's email. Only the protocol's display email leaves here.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { userHome } from "../env-path.ts";
import { botBox } from "../bot-box/box.ts";
import { killCliTree, spawnCli } from "../procs.ts";

const MAX_OUTPUT = 16_384;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function codexHome(env: Record<string, string | undefined>): string | null {
  if (env.CODEX_HOME) return isAbsolute(env.CODEX_HOME) ? resolve(env.CODEX_HOME) : null;
  const home = userHome(env);
  return isAbsolute(home) ? join(home, ".codex") : null;
}

/**
 * Security: the server's own reads of Codex (this account read, the model catalog) run outside the bot box with the
 * server's HOME, where a bot can write ~/.codex/config.toml. A provider there with an `auth.command` is run by
 * `codex app-server` when it lists models (seen with codex-cli 0.160.1), so where the box is on, or required, these reads
 * name OpenAI's provider (the account and catalog they are about) and a planted one is never active. Elsewhere nothing
 * boxed writes that HOME, and they read as before. server/drivers/planted-home-config.test.ts.
 */
export const CODEX_OFFICIAL_READ_ARGS: readonly string[] = ["app-server", "-c", 'model_provider="openai"'];

export function codexReadArgs(boxOn = botBox.enabled() || botBox.refusing()): string[] {
  return boxOn ? [...CODEX_OFFICIAL_READ_ARGS] : ["app-server"];
}

/** Unsupported CLIs and uncertain answers stay unnamed; never fall back to a possibly inactive credential file. */
export async function codexAccountEmail(
  cli: string,
  env: Record<string, string | undefined>,
  timeoutMs = 3_000,
): Promise<string | null> {
  const cwd = env.HOME || env.USERPROFILE || homedir();
  if (!isAbsolute(cwd) || !codexHome(env)) return null;
  return new Promise((resolveEmail) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(cli, codexReadArgs(), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolveEmail(null);
      return;
    }
    let finishing = false;
    let buffer = "";
    let outputBytes = 0;
    let initialized = false;
    const finish = async (email: string | null) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      let stopped = await killCliTree(child, 1_000);
      if (!stopped && child.pid) {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch {}
        }
        stopped = await killCliTree(child, 1_000);
      }
      resolveEmail(stopped ? email : null);
    };
    const timer = setTimeout(() => { void finish(null); }, timeoutMs);
    timer.unref();
    const send = (message: unknown) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { void finish(null); }
    };
    child.stdin.on("error", () => { void finish(null); });
    child.stderr.resume(); // Do not retain or log raw CLI errors or credentials.
    child.on("error", () => { void finish(null); });
    child.on("close", () => { void finish(null); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (finishing) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT) { void finish(null); return; }
      buffer += chunk;
      let newline: number;
      while (!finishing && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { void finish(null); return; }
        if (!initialized && message?.id === 1) {
          if (message.error || !message.result) { void finish(null); return; }
          initialized = true;
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/read", params: { refreshToken: false } });
        } else if (initialized && message?.id === 2) {
          const account = message.error ? null : message.result?.account;
          const email = account?.type === "chatgpt" ? account.email : null;
          void finish(typeof email === "string" && email.length <= 254 && EMAIL.test(email) && !/[\p{Cc}\p{Cf}]/u.test(email) ? email : null);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "openmausbot", version: "1" } } });
  });
}
