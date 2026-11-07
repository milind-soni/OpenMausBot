import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "src", "index.ts");
const RECORDER = pathToFileURL(join(HERE, "fixtures", "record-exec.mjs")).href;
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
async function startSidecar(env: Record<string, string>): Promise<{ programs: string[][]; out: string }> {
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
  let out = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the sidecar never came up:\n${out}`)), 15_000);
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("companion  ")) {
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
  const programs = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
  return { programs, out };
}

const isTailscale = (program: string[]) => /tailscale/i.test(program[0] ?? "");

describe("the phone link and Tailscale", () => {
  it("never runs a Tailscale program when it starts, with Tailscale off or on", async () => {
    expect((await startSidecar({})).programs.filter(isTailscale)).toEqual([]);
    const on = await startSidecar({ OMB_COMPANION_ROUTES: "wifi,tailscale", OMB_COMPANION_TAILNET_NAME: "mac.tail1.ts.net" });
    expect(on.programs.filter(isTailscale)).toEqual([]);
    expect(on.out).toContain("(wifi, tailscale)");
  }, 30_000);

  it("binds no device port when only the relay or the HTTPS address is on", async () => {
    const { out } = await startSidecar({ OMB_COMPANION_ROUTES: "" });
    expect(out).toContain("no direct way in is on");
    expect(out).not.toContain("http://0.0.0.0");
  }, 30_000);
});
