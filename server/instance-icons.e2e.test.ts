// Real server: the engine list carries each OpenAI-compatible server's mark, so every client shows it without the address.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

// No key and a fixed model list: the server never asks these hosts for anything.
const server = (url: string, extra: object = {}) => ({ driver: "openai-compat", ...extra, config: { url, managedModels: ["fixture-model"] } });

it("lists an OpenAI-compatible server with its provider's mark, and a stored icon over it", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-instance-icons-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: {
      deepseekServer: server("https://api.deepseek.com/v1", { displayName: "DeepSeek" }),
      lookalike: server("https://api.openai.com.evil.test/v1"),
      ownIcon: server("https://api.x.ai/v1", { icon: { kind: "preset", preset: "cohere" } }),
    },
  }));
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT, env: verificationServerEnvironment(process.env, home, port), stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);

  const response = await fetch(`${base}/api/instances`, { headers: { origin: base } });
  expect(response.status).toBe(200);
  const { instances } = await response.json() as { instances: Array<{ instanceId: string; icon?: unknown }> };
  const icon = (id: string) => instances.find((instance) => instance.instanceId === id)!.icon;
  expect(icon("deepseekServer")).toEqual({ kind: "preset", preset: "deepseek" });
  expect(icon("lookalike")).toBeUndefined();
  expect(icon("ownIcon")).toEqual({ kind: "preset", preset: "cohere" });
}, 60_000);
