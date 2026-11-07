import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "src", "index.ts");
const RECORDER = join(HERE, "fixtures", "record-exec.mjs");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

/** Starts a real sidecar until it says it is up, and returns every program it tried to run meanwhile. */
async function programsRunAtStart(env: Record<string, string>): Promise<string[][]> {
  const home = mkdtempSync(join(tmpdir(), "omb-companion-tailscale-"));
  dirs.push(home);
  const record = join(home, "exec.jsonl");
  const [companionPort, controlPort] = [await freePort(), await freePort()];
  const child = spawn(process.execPath, ["--import", RECORDER, ENTRY], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      OMB_COMPANION_DIR: join(home, "companion"),
      OMB_PORT: "9150",
      OMB_COMPANION_PORT: String(companionPort),
      OMB_CONTROL_PORT: String(controlPort),
      OMB_COMPANION_BONJOUR: "0",
      RECORD_EXEC_FILE: record,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`the sidecar never came up:\n${out}`)), 15_000);
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("companion  http://")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on("data", (chunk) => (out += chunk));
      child.once("exit", (code) => reject(new Error(`the sidecar exited (${code}):\n${out}`)));
    });
  } finally {
    child.kill("SIGKILL");
  }
  if (!existsSync(record)) return [];
  return readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

const isTailscale = (program: string[]) => /tailscale/i.test(program[0] ?? "");

describe("the phone link and Tailscale", () => {
  it("runs no Tailscale program when it starts, unless the person turned Tailscale on", async () => {
    expect((await programsRunAtStart({})).filter(isTailscale)).toEqual([]);
  }, 30_000);

  it("asks Tailscale for this computer's name at start once Tailscale is on, the CLI before the macOS app", async () => {
    const tailscale = (await programsRunAtStart({ OMB_COMPANION_TAILSCALE: "1" })).filter(isTailscale);
    expect(tailscale.length).toBeGreaterThan(0);
    expect(tailscale[0]).toEqual(["/opt/homebrew/bin/tailscale", "status", "--json"]);
    expect(tailscale.at(-1)?.[0]).toMatch(/Tailscale\.app/);
  }, 30_000);
});
