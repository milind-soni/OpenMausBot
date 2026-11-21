// Security: a server configured for hosted sign-in (OMB_ADMIN_*) with no enterprise layer must refuse remote callers
// and keep the owner's loopback access.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { SessionRegistry } from "./sessions.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "acme.example.test";
let port: number;
let home: string;
let child: ChildProcess;
let log = "";
let pairedToken: string;

function call(path: string, options: { method?: string; token?: string; local?: boolean } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers: {
      ...(options.local ? {} : { host: HOST, "x-forwarded-for": "203.0.113.8", "x-forwarded-proto": "https" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => { let body: unknown = raw; try { body = JSON.parse(raw); } catch {} resolve({ status: res.statusCode!, body }); });
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  port = await freePortBlock([0, 1], 35_000, 5_000);
  home = mkdtempSync(join(tmpdir(), "omb-hosted-oss-"));
  const data = join(home, ".edubot");
  mkdirSync(join(home, "static"), { recursive: true });
  writeFileSync(join(home, "static", "index.html"), "<!doctype html><title>Fixture workspace</title>");
  pairedToken = new SessionRegistry({ file: join(data, "sessions.json") }).issue({ label: "Pre-existing QR device", scopes: ["admin", "client"] }).token;
  child = spawn(process.execPath, [join(ROOT, "server/index.ts")], { cwd: ROOT, env: {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
    OMB_STATIC_DIR: join(home, "static"), OMB_BROWSER_CONNECTION: join(home, "browser-connection.json"),
    OMB_ENTERPRISE_DIR: join(home, "absent-layer"), OMB_LICENSE_KEY: "omb1.not.real",
    OMB_ADMIN_URL: "https://admin.example.test", OMB_ADMIN_WORKSPACE: "acme", OMB_ADMIN_MEMBERSHIP: "portal",
    OMB_PUBLIC_URL: `https://${HOST}`, OMB_LOOPBACK_TRUST: "owner",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => log += chunk);
  child.stderr?.on("data", (chunk) => log += chunk);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try { if ((await call("/api/health", { local: true })).status === 200) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The hosted fixture without an enterprise layer failed to start:\n${log}`);
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("runs the open-source edition", async () => {
  expect((await call("/api/edition", { local: true })).body.edition).toBe("oss");
});

it("refuses every remote way in, a QR token paired earlier included", async () => {
  expect((await call("/api/health/hosted")).status).toBe(503);
  expect((await call("/api/auth/hosted/start")).status).toBe(503);
  expect((await call("/")).status).toBe(503);
  expect((await call("/pair")).status).toBe(503);
  expect((await call("/api/auth/session", { token: pairedToken })).status).toBe(503);
  expect((await call("/api/auth/email/verify", { method: "POST" })).status).toBe(403);
});

it("keeps the owner's loopback access on this machine", async () => {
  const session = await call("/api/auth/session", { local: true });
  expect(session.status).toBe(200);
  expect(session.body.kind).toBe("loopback");
});
