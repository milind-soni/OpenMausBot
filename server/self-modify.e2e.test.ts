// End-to-end verification of the self-modify subsystem's server wiring, on
// an isolated fixture (throwaway data dir, random port, fake engine) per
// docs/verification/README.md.
//
// What is proven here, through the REAL server and REAL endpoints:
//   1. the feature is off by default and the API says so;
//   2. config PATCH flips it on without a restart;
//   3. the journal status surface lists entries;
//   4. the trial-boot lifecycle: an entry left `applied` on disk is marked
//      with THIS boot's pid, adopted over the abandoned-proposal sweep, and
//      promoted to `verified` the moment the listener is up;
//   5. the boot-crash path: a listener-bind failure under a live proposal
//      reverts the entry and clears the boot marker.
//
// What is deliberately NOT done here: applying proposals that write real
// files. This e2e launches the repo's own server/index.ts, so any applied
// file edit would mutate the real repo — the one thing verification must
// never do. File-level mechanics (snapshot, apply, preflight-gate revert,
// byte-exact restore) are covered in server/self-modify.test.ts against
// throwaway project roots, and the detached watchdog's own revert path in
// electron/self-modify-watchdog.test.mjs.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A journal entry on disk whose "edit" targets nothing real: its single
 * file does not exist anywhere and its backup path is fictional, so even a
 * mistaken revert could not damage the repo (restore is a per-file no-op). */
function craftedEntry(id: string): unknown {
  return {
    proposal: {
      id,
      proposedBy: "e2e-verification",
      reason: "verify the trial-boot lifecycle",
      files: [{ path: "server/no-such-file.e2e.ts", action: "create", content: "// never applied anywhere real\n" }],
    },
    status: "applied",
    appliedAt: new Date().toISOString(),
    entries: [{ path: "server/no-such-file.e2e.ts", backupPath: join("/nonexistent", `${id}.bak`), deleted: true }],
  };
}

function journalFile(dataDir: string, id: string): string {
  return join(dataDir, "self-modify", "journal", `${id}.json`);
}

interface E2eEntry {
  status: string;
  bootMarker?: { pid: number };
  verifiedAt?: string;
  revertReason?: string;
}

function readEntry(dataDir: string, id: string): E2eEntry {
  return JSON.parse(readFileSync(journalFile(dataDir, id), "utf8")) as E2eEntry;
}

/** Restart a server against an existing fixture data dir, the way
 * chat-followups-restart.test.ts does. OMB_SELF_MODIFY opts the trial-boot
 * machinery in without touching the fixture's config file. */
function startServer(opts: { dataDir: string; port: string; logPath: string }): ChildProcess {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"].includes(key.toUpperCase()) && value) env[key.toUpperCase()] = value;
  }
  Object.assign(env, {
    HOME: opts.dataDir,
    USERPROFILE: opts.dataDir,
    OMB_DATA_DIR: opts.dataDir,
    APPDATA: join(opts.dataDir, "AppData", "Roaming"),
    LOCALAPPDATA: join(opts.dataDir, "AppData", "Local"),
    XDG_CONFIG_HOME: join(opts.dataDir, ".config"),
    XDG_CACHE_HOME: join(opts.dataDir, ".cache"),
    XDG_DATA_HOME: join(opts.dataDir, ".local", "share"),
    HERMES_HOME: join(opts.dataDir, ".hermes"),
    TEMP: join(opts.dataDir, "tmp"),
    TMP: join(opts.dataDir, "tmp"),
    TMPDIR: join(opts.dataDir, "tmp"),
    OMB_PORT: opts.port,
    OMB_WEBHOOK_PORT: String(Number(opts.port) + 1),
    PATH: dirname(process.execPath),
    OMB_SELF_MODIFY: "1",
  });
  const log = openSync(opts.logPath, "a", 0o600);
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  return child;
}

async function waitHealthy(url: string, child: ChildProcess, logPath: string): Promise<void> {
  await expect.poll(async () => {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      return (await response.json() as { app?: string }).app === "openmausbot";
    } catch {
      return false;
    }
  }, { timeout: 20_000, message: `server never became healthy; see ${logPath}` }).toBe(true);
}

describe("self-modify server wiring", () => {
  it("is off by default, config-flippable, verifies a trial boot, and reverts on a boot crash", async () => {
    const fixture = await launchVerificationServer();
    const { url, dataDir, logPath } = fixture.info;
    const api = async (method: string, path: string, body?: unknown, status = 200) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5_000),
      });
      const result = await response.json() as Record<string, unknown>;
      expect(response.status, JSON.stringify(result)).toBe(status);
      return result;
    };
    try {
      // 1. Off by default: the endpoint refuses, and the status flag is false.
      await api("GET", "/api/self-modify", undefined, 403);
      const config1 = await api("GET", "/api/config");
      expect((config1.features as Record<string, unknown> | undefined)?.selfModify).toBe(false);

      // 2. Config PATCH turns it on, live, without a restart.
      await api("PATCH", "/api/config", { features: { selfModify: true } });
      const config2 = await api("GET", "/api/config");
      expect((config2.features as Record<string, unknown>)?.selfModify).toBe(true);
      const listing = await api("GET", "/api/self-modify") as { journal: Array<{ status: string }>; pending: unknown[]; enabled: boolean };
      expect(listing.enabled).toBe(true);
      expect(listing.journal).toEqual([]);
      expect(listing.pending).toEqual([]);

      // 3. Craft an `applied` entry that touches nothing real, then stop the
      // fixture's server WITHOUT fixture.close(): close() also deletes the
      // fixture's data dir, which must survive for the trial boot.
      mkdirSync(join(dataDir, "self-modify", "journal"), { recursive: true });
      writeFileSync(journalFile(dataDir, "sm-live"), JSON.stringify(craftedEntry("sm-live"), null, 2));
      const port = new URL(url).port;
      fixture.child.kill("SIGTERM");
      await waitForExit(fixture.child, { signal: "SIGTERM" });

      // 4. Trial boot: this next boot marks the entry with its pid, keeps it
      // from the abandoned sweep, and verifies it when the listener is up.
      let child = startServer({ dataDir, port, logPath });
      try {
        await waitHealthy(url, child, logPath);
        await expect.poll(() => readEntry(dataDir, "sm-live").status, { timeout: 10_000 }).toBe("verified");
        const verified = readEntry(dataDir, "sm-live");
        expect(verified.verifiedAt).toBeTruthy();
        expect(existsSync(join(dataDir, "self-modify", "boot-marker.json"))).toBe(false);
      } finally {
        child.kill("SIGTERM");
        await waitForExit(child, { signal: "SIGTERM" });
      }

      // 5. Boot-crash path: a live proposal plus a guaranteed bind failure
      // (a holder owns the port) must end `reverted` with the marker gone.
      // The revert reason may come from the boot guard or the detached
      // watchdog — both are the safety system working.
      writeFileSync(journalFile(dataDir, "sm-crash"), JSON.stringify(craftedEntry("sm-crash"), null, 2));
      const holder = spawn(
        process.execPath,
        ["-e", `require("net").createServer().listen(${Number(port)}, "127.0.0.1", () => console.log("held")); setInterval(() => {}, 1000);`],
        { stdio: "ignore" },
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        child = startServer({ dataDir, port, logPath });
        await expect.poll(() => readEntry(dataDir, "sm-crash").status, { timeout: 20_000 }).toBe("reverted");
        const reverted = readEntry(dataDir, "sm-crash");
        expect(reverted.revertReason ?? "").toMatch(/boot crashed|watchdog/);
        expect(existsSync(join(dataDir, "self-modify", "boot-marker.json"))).toBe(false);
      } finally {
        holder.kill("SIGKILL");
        child.kill("SIGTERM");
        await waitForExit(child, { signal: "SIGTERM" }).catch(() => undefined);
      }
    } finally {
      await fixture.close();
    }
  }, 180_000);
});
