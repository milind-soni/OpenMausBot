// Linux, with a real gh on PATH (GitHub's Linux runners have one): gh reaches the keyring through the session bus address
// it is given, so the dead address ownGhEnv sets is the one it dials, never the person's Secret Service. Without an
// address godbus would find /run/user/<uid>/bus by the uid; this proves a set address is what decides.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findCliCandidates } from "../env-path.ts";
import { ownGhEnv } from "./gh-cli.ts";

const gh = process.platform === "linux" ? findCliCandidates("gh")[0] : undefined;

const run = (env: Record<string, string>) => new Promise<{ code: number | null; output: string }>((resolve) => {
  execFile(gh!, ["auth", "token", "--hostname", "github.com"], { env, timeout: 60_000, encoding: "utf8" }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0, output: `${stdout}${stderr}` });
  });
});

let dir = "";
let bus: Server | null = null;
afterEach(() => {
  bus?.close();
  bus = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!gh)("GitHub CLI and the D-Bus session (Linux)", () => {
  it("dials the address it is given, so OpenMausBot's dead one keeps it away from the person's keyring", async () => {
    dir = mkdtempSync(join(tmpdir(), "omb-gh-dbus-"));
    const folders = { home: join(dir, "home"), config: join(dir, "config") };
    for (const folder of [folders.home, folders.config, join(folders.home, ".run")]) mkdirSync(folder, { recursive: true });
    let dialled = 0;
    const socket = join(dir, "bus.sock");
    bus = createServer((connection) => {
      dialled++;
      connection.destroy();
    });
    await new Promise<void>((resolve) => bus!.listen(socket, resolve));

    // With no saved sign-in, gh asks the keyring, over the session bus at the address it was given.
    const listening = await run({ ...ownGhEnv(folders), DBUS_SESSION_BUS_ADDRESS: `unix:path=${socket}` });
    expect(listening.code).not.toBe(0);
    expect(dialled).toBeGreaterThan(0);

    // OpenMausBot's own address: nothing there, the keyring is unavailable, and gh simply has no token.
    dialled = 0;
    const own = await run(ownGhEnv(folders));
    expect(own.code).not.toBe(0);
    expect(own.output).not.toMatch(/gh[ou]_|github_pat_/u);
    expect(dialled).toBe(0);
  });
});
