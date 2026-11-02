// The real CLI starts the real server in a disposable home with OMB_LOOPBACK_TRUST=service.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(SERVER_DIR, "openmausbot.ts");
const run = promisify(execFile);

let home: string;
let PORT: number;
let serve: ChildProcess;
let output = "";

const environment = () => ({
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  HOME: home, USERPROFILE: home, OMB_WEBHOOK_PORT: String(PORT + 1), OMB_LOOPBACK_TRUST: "service",
});
const cli = async (args: string[]) => {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--experimental-strip-types", ENTRY, ...args, "--port", String(PORT), "--data-dir", join(home, "data")], { env: environment(), timeout: 20_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
};

describe.skipIf(process.platform === "win32")("openmausbot serve under service loopback trust", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-cli-service-"));
    PORT = await freePortBlock([0, 1]);
    serve = spawn(process.execPath, ["--experimental-strip-types", ENTRY, "serve", "--port", String(PORT), "--data-dir", join(home, "data")], {
      env: environment(), stdio: ["ignore", "pipe", "pipe"],
    });
    serve.stdout!.on("data", (chunk) => (output += chunk));
    serve.stderr!.on("data", (chunk) => (output += chunk));
    const deadline = Date.now() + 40_000;
    while (!output.includes("stop with Ctrl+C")) {
      if (serve.exitCode !== null) throw new Error(`serve exited:\n${output}`);
      if (Date.now() > deadline) throw new Error(`serve never finished starting:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 60_000);

  afterAll(async () => {
    await waitForExit(serve, { signal: "SIGINT" });
    await removeTempDir(home);
  });

  it("prints a pairing code for the CLI that started the server and keeps running", async () => {
    expect(output).toContain("local requests: service trust (OMB_LOOPBACK_TRUST)");
    expect(output).toMatch(/pairing code: {2}[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect(output).not.toContain("no pairing code");
    expect(serve.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${PORT}/api/health`)).status).toBe(200);
  });

  it("refuses everyone else on this machine the pairing route", async () => {
    for (const headers of [{}, { "x-openmausbot-cli-owner": "x".repeat(43) }]) {
      const minted = await fetch(`http://127.0.0.1:${PORT}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
      expect(minted.status).toBe(403);
    }
  });

  it("explains itself to separate CLI commands instead of printing an empty answer", async () => {
    for (const args of [["sessions"], ["sessions", "revoke", "sess-1"], ["pair", "--label", "Kitchen iPad"]]) {
      const result = await cli(args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain("does not treat commands on this computer as its owner");
      expect(result.stdout).not.toContain("no paired devices yet");
    }
  }, 60_000);
});
