// OMB_PROFILE=auto throughout: these servers run from source, which never turns the profile on by itself, and the built
// image's own default is proved in .github/workflows/docker.yml ("The hardened profile").
// The real CLI starts the real server in a disposable home, once as each kind of server: one person's own, one more than
// one person can sign in to, and that one with the profile declined. What the shared one does depends on the host, and
// each branch is the product's answer there: Linux with a working bubblewrap runs the whole profile, Linux without one
// refuses to start (this is what CI's Linux runners prove), and macOS has no box, so it starts as a service and says so.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { detectBox } from "./bot-box/detect.ts";
import { PROFILE_REFUSED_EXIT_CODE } from "./server-profile-boot.ts";
import { OPERATOR_TOKEN_FILE } from "./server-profile.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "openmausbot.ts");
const run = promisify(execFile);
const AUTO = { OMB_PROFILE: "auto" };
const SHARED = { ...AUTO, OMB_SIGNIN_EMAILS: "owner@example.com", OMB_SIGNIN_MEMBER_EMAILS: "member@example.com" };
const boxWorksHere = detectBox({ env: process.env, hardened: true }).box === "bwrap";

interface Started { home: string; port: number; serve: ChildProcess; output: () => string; env: NodeJS.ProcessEnv }
const running: Started[] = [];

async function start(extra: NodeJS.ProcessEnv, until: (output: string, serve: ChildProcess) => boolean): Promise<Started> {
  const home = mkdtempSync(join(tmpdir(), "omb-profile-e2e-"));
  const port = await freePortBlock([0, 1]);
  const env: NodeJS.ProcessEnv = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home, OMB_WEBHOOK_PORT: String(port + 1), ...extra,
  };
  let output = "";
  const serve = spawn(process.execPath, ["--experimental-strip-types", ENTRY, "serve", "--port", String(port), "--data-dir", join(home, "data")], { env, stdio: ["ignore", "pipe", "pipe"] });
  serve.stdout!.on("data", (chunk) => (output += chunk));
  serve.stderr!.on("data", (chunk) => (output += chunk));
  const started: Started = { home, port, serve, output: () => output, env };
  running.push(started);
  const deadline = Date.now() + 60_000;
  while (!until(output, serve)) {
    if (Date.now() > deadline) throw new Error(`serve did not get there:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return started;
}

const up = (output: string, serve: ChildProcess) => {
  if (serve.exitCode !== null) throw new Error(`serve exited:\n${output}`);
  return output.includes("local requests: ");
};
const local = (started: Started, method: string, path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${started.port}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(method === "GET" ? {} : { body: "{}" }) });
const healthy = async (started: Started) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await local(started, "GET", "/api/health")).status === 200) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the server never answered:\n${started.output()}`);
};
const pair = async (started: Started) => {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--experimental-strip-types", ENTRY, "pair", "--port", String(started.port), "--data-dir", join(started.home, "data")], { env: started.env, timeout: 20_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
};

describe.skipIf(process.platform === "win32")("a server started in its profile", () => {
  afterEach(async () => {
    for (const started of running.splice(0)) {
      if (started.serve.exitCode === null) await waitForExit(started.serve, { signal: "SIGINT" });
      await removeTempDir(started.home);
    }
  });

  it("is exactly as before for one owner: standard, owner trust, the local API open to them, nothing new on disk", async () => {
    const server = await start(AUTO, up);
    await healthy(server);
    expect(server.output()).toContain("server profile: standard (one-owner)");
    expect(server.output()).toContain("bot box: off (not-cloud)");
    expect(server.output()).toContain("local requests: owner trust (self-hosted default)");
    const config = await local(server, "GET", "/api/config");
    expect(config.status).toBe(200);
    expect(((await config.json()) as { serverProfile?: unknown }).serverProfile).toEqual({ profile: "standard", boxed: false });
    expect((await local(server, "POST", "/api/auth/pairing")).status).toBe(200);
    expect(existsSync(join(server.home, "data", OPERATOR_TOKEN_FILE))).toBe(false);
    expect(existsSync(join(server.home, "data", "server-profile.json"))).toBe(false);
  }, 120_000);

  it.runIf(process.platform === "linux" && !boxWorksHere)("does not start a new shared server whose bots cannot be boxed, and says what to fix", async () => {
    const server = await start(SHARED, (_output, serve) => serve.exitCode !== null);
    expect(server.serve.exitCode).toBe(PROFILE_REFUSED_EXIT_CODE);
    expect(server.output()).toMatch(/OpenMausBot did not start: more than one person can sign in to this server, so its bots must run in a sandbox, and here they can't\./);
    expect(server.output()).toMatch(/Install bubblewrap|unprivileged user namespaces are off/);
    expect(server.output()).toMatch(/Nothing was changed\. To run without the sandbox anyway, set OMB_PROFILE=standard/);
    expect(server.output()).not.toContain("local requests: ");
    await expect(local(server, "GET", "/api/health")).rejects.toThrow();
  }, 120_000);

  it.runIf(boxWorksHere)("runs a shared server's whole profile where the box works: a service to local requests, pairing only by the operator's token", async () => {
    const server = await start(SHARED, up);
    await healthy(server);
    expect(server.output()).toContain("bot box: on (bubblewrap");
    expect(server.output()).toContain("server profile: hardened (shared); bots run in a sandbox");
    expect(server.output()).toContain("local requests: service trust (hardened profile)");
    for (const [method, path] of [["GET", "/api/config"], ["PUT", "/api/config"], ["POST", "/api/auth/pairing"], ["POST", "/api/bots/bot-1/messages/guarded"], ["GET", "/api/bots"]] as const) {
      expect((await local(server, method, path)).status, `${method} ${path}`).toBe(403);
    }
    expect((await local(server, "POST", "/api/auth/pairing", { "x-openmausbot-cli-owner": "x".repeat(43) })).status).toBe(403);
    const paired = await pair(server);
    expect(paired.code, paired.stderr).toBe(0);
    expect(paired.stdout).toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
  }, 120_000);

  it.runIf(process.platform === "darwin")("has no box on macOS: a shared server there is a service to local requests and says its bots are not sandboxed", async () => {
    const server = await start(SHARED, up);
    await healthy(server);
    expect(server.output()).toMatch(/server profile: hardened \(shared\), but the bots are NOT sandboxed: The bots' sandbox needs Linux/);
    expect(server.output()).toContain("local requests: service trust (hardened profile); without a session, loopback may use only health and bot capability routes");
    for (const [method, path] of [["GET", "/api/config"], ["PUT", "/api/config"], ["POST", "/api/auth/pairing"], ["POST", "/api/bots/bot-1/messages/guarded"], ["POST", "/api/bots/bot-1/tasks"], ["GET", "/api/bots"]] as const) {
      expect((await local(server, method, path)).status, `${method} ${path}`).toBe(403);
    }
    expect((await local(server, "GET", "/api/health")).status).toBe(200);
    expect(existsSync(join(server.home, "data", OPERATOR_TOKEN_FILE))).toBe(false);
    const paired = await pair(server);
    expect(paired.code).toBe(1);
    expect(paired.stderr).toContain("does not treat commands on this computer as its owner");
  }, 120_000);

  it("leaves a shared server run from source as it was, and says the profile is not on", async () => {
    const { OMB_PROFILE: _auto, ...shared } = SHARED;
    const server = await start(shared, up);
    await healthy(server);
    expect(server.output()).toMatch(/server profile: this server runs from source, where the hardened profile is not turned on by itself, and more than one person can sign in/);
    expect(server.output()).toContain("server profile: standard (from-source)");
    expect(server.output()).toContain("local requests: owner trust (self-hosted default)");
    expect((await local(server, "GET", "/api/config")).status).toBe(200);
  }, 120_000);

  it("starts a shared server whose operator declined the profile, as before, and warns on every start", async () => {
    const server = await start({ ...SHARED, OMB_PROFILE: "standard" }, up);
    await healthy(server);
    expect(server.output()).toMatch(/server profile: OMB_PROFILE=standard on a server more than one person can sign in to: anyone who can chat with a bot can make it read this server's AI keys/);
    expect(server.output()).toContain("server profile: standard (switched-off)");
    expect(server.output()).toContain("local requests: owner trust (self-hosted default)");
    expect((await local(server, "GET", "/api/config")).status).toBe(200);
  }, 120_000);
});
