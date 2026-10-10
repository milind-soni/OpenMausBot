// Capture survives a restart: a 1:1 turn still waiting for the quiet spell
// when the server stops is saved as ids (never its text), read back from the
// transcript at the next start, and captured then. Before this the waiting
// turns were dropped on every quit, update or restart.
//
// POSIX only: a Windows SIGTERM ends the process without its shutdown hooks.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";
import { CAPTURE_MARKER } from "./memory-capture.ts";
import { waitForExit } from "./testing/cleanup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

it.skipIf(process.platform === "win32")("captures a turn that was still waiting when the server stopped, after the next start", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-capture-restart-"));
  const routes = join(scratch, "routes.json");
  writeFileSync(routes, JSON.stringify({
    [CAPTURE_MARKER]: JSON.stringify([{ text: "The person plays the cello on Sundays", kind: "fact", confidence: 0.9 }]),
  }));
  const parentEnv = { ...process.env, FAKE_CLAUDE_TEXT_ROUTES: routes };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, dataDir } = fixture.info;
  let restarted: ChildProcess | undefined;
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const pending = join(dataDir, "memory-capture-pending.json");
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Cellist" }, 201);
    // a quiet spell far longer than this test: the turn is still waiting at the stop
    await api("/api/config", "PUT", { memory: { captureQuietMs: 600_000 } });
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "I play the cello every Sunday morning.", "--url", url]);
    expect(await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const saved = readFileSync(pending, "utf8");
    expect(saved).toContain(bot.threadId);
    expect(saved).not.toContain("cello");

    const config = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ ...config, memory: { ...config.memory, captureQuietMs: 1_000 } }, null, 2));
    restarted = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
      cwd: ROOT,
      env: verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)),
      stdio: "ignore",
    });
    await expect.poll(async () => {
      try {
        return (await fetch(`${url}/api/health`)).ok;
      } catch {
        return false;
      }
    }, { timeout: 20_000, interval: 150 }).toBe(true);
    // upkeep starts once the engines are read, a moment after health answers
    await expect.poll(async () => (await api<{ text: string }>(`/api/bots/${bot.id}/memory/file?path=MEMORY.md`)).text, { timeout: 20_000 })
      .toContain("The person plays the cello on Sundays");
    expect(existsSync(pending)).toBe(false);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);
