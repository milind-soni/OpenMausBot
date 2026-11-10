// A Cloud home that moved to another provider, asked the way its old address's forwarder asks: Host rewritten to the
// home's new name, the browser's own Origin (the old address) kept. With OMB_CLOUD_LEGACY_ORIGINS naming that address, a
// browser signed in there goes on working; any other Origin is refused as before, and a malformed list stops the home.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const NEW_HOST = "omb-u-0a1b2c3d4e5f.homes.example", OLD = "https://omb-u-0a1b2c3d4e5f.fly.dev";
const secret = randomBytes(32).toString("base64url");
// Anything but loopback fails here, so the home reaches nothing outside the test.
const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
const homes: string[] = [];
let child: ChildProcess | undefined;
let base = "", log = "", cookie = "";

async function launch(legacy: string, port: number): Promise<{ child: ChildProcess; output: () => string }> {
  const home = mkdtempSync(join(tmpdir(), "omb-cloud-legacy-origin-"));
  homes.push(home);
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  let output = "";
  const started = spawn(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "5c9e3d2f-0b8a-4f7e-9d6c-2b3c4d5e6f70", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${NEW_HOST}`, OMB_CLOUD_LEGACY_ORIGINS: legacy,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.stdout?.on("data", (chunk) => { output += chunk; });
  started.stderr?.on("data", (chunk) => { output += chunk; });
  return { child: started, output: () => output };
}

/** Through the forwarder: the home's new name as Host, the edge's own forwarding headers, and X-Forwarded-Host naming the
 * old address, which the home must never read. */
const forwarded = (origin: string, extra: Record<string, string> = {}) => ({
  host: NEW_HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "x-forwarded-host": new URL(OLD).host, origin, ...extra,
});

/** Headers sent exactly as given: fetch would put its own Host in place of the forwarder's. */
function raw(method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; cookie: string; body: any }>((resolve, reject) => {
    const target = new URL(path, base);
    const sent = request({ hostname: target.hostname, port: target.port, path: target.pathname, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode ?? 0, cookie: String(res.headers["set-cookie"]?.[0] ?? "").split(";")[0]!, body: parsed });
      });
    });
    sent.on("error", reject);
    sent.end(body);
  });
}

async function call(method: string, path: string, origin: string) {
  const { status, body } = await raw(method, path, forwarded(origin, { cookie, ...(method === "GET" ? {} : { "content-type": "application/json" }) }), method === "GET" ? undefined : "{}");
  return { status, body };
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const launched = await launch(`${OLD},https://omb-u-older.example.test`, port);
  child = launched.child;
  const deadline = Date.now() + 25_000;
  for (;;) {
    log = launched.output();
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The Admin's signed pairing request, then a browser redeeming its code into its own cookie at the old address.
  const body = JSON.stringify({ label: "Chrome on Mac", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await raw("POST", "/api/cloud/pairing", {
    host: NEW_HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body);
  const paired = await raw("POST", "/api/auth/pair", forwarded(OLD, { "content-type": "application/json" }), JSON.stringify({ code: granted.body.code, cookie: true }));
  expect(paired.status, launched.output().slice(-2000)).toBe(200);
  cookie = paired.cookie;
  expect(cookie).toMatch(/^omb_session_\d+_\w+=omb_sess_/);
}, 60_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes) await removeTempDir(home);
  vi.restoreAllMocks();
});

it("takes a browser on the old address as its own, and refuses every other Origin as before", async () => {
  expect((await call("GET", "/api/bots", OLD)).status, log.slice(-2000)).toBe(200);
  expect((await call("POST", "/api/notifications/read-all", OLD)).status).toBe(200);
  expect((await call("GET", "/api/bots", "https://omb-u-older.example.test")).status).toBe(200);
  expect((await call("GET", "/api/bots", `https://${NEW_HOST}`)).status).toBe(200);
  for (const origin of ["https://evil.example", "https://omb-u-other.fly.dev", OLD.replace("https:", "http:")]) {
    const refused = await call("POST", "/api/notifications/read-all", origin);
    expect(refused, origin).toEqual({ status: 403, body: { error: "forbidden: cross-origin request" } });
  }
}, 60_000);

it("refuses to start with a former address that is not an exact https origin", async () => {
  const port = await freePortBlock([0, 1]);
  const bad = await launch("http://omb-u-0a1b2c3d4e5f.fly.dev", port);
  await new Promise<void>((resolve) => { if (bad.child.exitCode !== null) resolve(); else bad.child.once("exit", () => resolve()); });
  expect(bad.child.exitCode).not.toBe(0);
  expect(bad.output()).toMatch(/Cloud home configuration is invalid: every OMB_CLOUD_LEGACY_ORIGINS entry must be an exact https origin/);
}, 60_000);
