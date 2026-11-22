import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { loginAt, nativeFixture, type NativeFixture } from "../testing/antigravity-native-fixture.ts";
import { prepareAntigravityProfile, type AntigravityProfile } from "./antigravity-acp.ts";
import {
  antigravityNativeCredentials,
  antigravityNativeCredentialsHeld,
  clearAntigravityNativeCredentials,
  noteAntigravityNativeCredentials,
} from "./antigravity-native-credentials.ts";
import { NativeSignInCache, antigravityCliSignIn, antigravityNativeTokenPath, signOutAntigravityCli } from "./antigravity-native-status.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";

const WINDOWS = process.platform === "win32";
const scratch: string[] = [];

afterEach(async () => {
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("the native CLI's sign-in state, asked of the CLI", () => {
  async function setup(env: Record<string, string> = {}) {
    const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-status-"));
    scratch.push(directory);
    const fixture: NativeFixture = nativeFixture(join(directory, "cli"));
    const runtime: AntigravityRuntime = { executablePath: fixture.executable, harnessPath: null, source: "override", version: "1.5.14" };
    const profile: AntigravityProfile = await prepareAntigravityProfile({
      instanceId: "status", runtime, baseDir: directory, baseEnv: { ...process.env, FAKE_AGY_LOG: fixture.log, ...env },
    });
    return { fixture, runtime, profile };
  }

  describe.skipIf(WINDOWS)("by whether a session is accepted", () => {
    it("is out on `Authentication required`, in once signed in, and closes the session it opened", async () => {
      const { fixture, runtime, profile } = await setup();
      expect(await antigravityCliSignIn(runtime, profile)).toBe("out");
      expect(await loginAt(fixture, profile.directory, "fixture-code")).toBe(0);
      expect(await antigravityCliSignIn(runtime, profile)).toBe("in");
      await vi.waitFor(() => expect(fixture.methods()).toEqual(expect.arrayContaining(["initialize", "session/new", "session/close"])));
      expect(fixture.methods()).not.toContain("authenticate");
    }, 60_000);

    it("says nothing, by throwing, when the CLI crashes or takes too long, and never says out", async () => {
      const crashing = await setup({ FAKE_AGY_HANG: "crash" });
      await expect(antigravityCliSignIn(crashing.runtime, crashing.profile)).rejects.toThrow(/exited/u);
      const hung = await setup({ FAKE_AGY_HANG: "session-new" });
      await expect(antigravityCliSignIn(hung.runtime, hung.profile, { requestMs: 300 })).rejects.toThrow(/timed out/u);
      const silent = await setup({ FAKE_AGY_HANG: "initialize" });
      await expect(antigravityCliSignIn(silent.runtime, silent.profile, { initializeMs: 300, capMs: 600 })).rejects.toThrow(/timed out/u);
    }, 60_000);

    it("does not take a refusal for another reason as a sign-in request", async () => {
      const { runtime, profile } = await setup();
      const missing = { ...runtime, executablePath: join(profile.directory, "no-such-cli") };
      await expect(antigravityCliSignIn(missing, profile)).rejects.toThrow();
    }, 60_000);
  });

  describe.skipIf(WINDOWS)("signing out", () => {
    it("logs out, removes the file store, and checks with a new process that no session is accepted", async () => {
      const { fixture, runtime, profile } = await setup();
      await loginAt(fixture, profile.directory, "fixture-code");
      expect(existsSync(antigravityNativeTokenPath(profile))).toBe(true);
      await signOutAntigravityCli(runtime, profile);
      expect(existsSync(antigravityNativeTokenPath(profile))).toBe(false);
      expect(fixture.methods()).toContain("logout");
      expect(await antigravityCliSignIn(runtime, profile)).toBe("out");
    }, 60_000);

    it("fails when the CLI still accepts a session, even though logout was refused or ignored", async () => {
      for (const logout of ["refuse", "ignore"]) {
        const keyring = mkdtempSync(join(tmpdir(), "omb-antigravity-keyring-"));
        scratch.push(keyring);
        const { fixture, runtime, profile } = await setup({ FAKE_AGY_KEYRING: keyring, FAKE_AGY_LOGOUT: logout });
        await loginAt(fixture, profile.directory, "fixture-code", { FAKE_AGY_KEYRING: keyring });
        await expect(signOutAntigravityCli(runtime, profile)).rejects.toThrow("still reports a Google sign-in");
      }
    }, 60_000);

    it("fails when the check cannot be made", async () => {
      const { fixture, runtime, profile } = await setup({ FAKE_AGY_HANG: "crash" });
      await loginAt(fixture, profile.directory, "fixture-code");
      await expect(signOutAntigravityCli(runtime, profile)).rejects.toThrow("could not confirm the sign-out");
    }, 60_000);
  });
});

describe("what was last read", () => {
  const runtime = "/cli/antigravity\u00001.5.14";
  const answers = (...states: Array<"in" | "out" | Error>) => {
    let calls = 0;
    return { read: async () => { const next = states[Math.min(calls++, states.length - 1)]!; if (next instanceof Error) throw next; return next; }, calls: () => calls };
  };

  it("is asked of the CLI once for a read that is still fresh, and again after its time", async () => {
    let now = 1_000;
    const cache = new NativeSignInCache({ ttlMs: 30_000, now: () => now });
    const source = answers("out", "in");
    expect(await cache.state("a", runtime, source.read)).toBe("out");
    now += 29_999;
    expect(await cache.state("a", runtime, source.read)).toBe("out");
    expect(source.calls()).toBe(1);
    now += 1;
    expect(await cache.state("a", runtime, source.read)).toBe("in");
    expect(source.calls()).toBe(2);
  });

  it("is kept for each instance apart", async () => {
    const cache = new NativeSignInCache();
    expect(await cache.state("a", runtime, async () => "in")).toBe("in");
    expect(await cache.state("b", runtime, async () => "out")).toBe("out");
  });

  it("shares a read in flight, and does not keep a failed one", async () => {
    const cache = new NativeSignInCache();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const slow = async () => { calls += 1; await held; return "in" as const; };
    const one = cache.state("a", runtime, slow);
    const two = cache.state("a", runtime, slow);
    release();
    expect(await Promise.all([one, two])).toEqual(["in", "in"]);
    expect(calls).toBe(1);
    const failing = answers(new Error("exited 3"), "out");
    await expect(cache.state("b", runtime, failing.read)).rejects.toThrow("exited 3");
    expect(await cache.state("b", runtime, failing.read)).toBe("out");
  });

  it("asks again after forget, and a read that began before it never writes its answer back", async () => {
    const cache = new NativeSignInCache();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const early = cache.state("a", runtime, async () => { await held; return "in" as const; });
    cache.forget("a");
    release();
    expect(await early).toBe("in");
    // The early read was before the sign-out: what it saw stands for nothing now.
    const next = answers("out");
    expect(await cache.state("a", runtime, next.read)).toBe("out");
    expect(next.calls()).toBe(1);
    expect(await cache.state("a", runtime, async () => { throw new Error("must be cached"); })).toBe("out");
    cache.forget("a");
    expect(await cache.state("a", runtime, async () => "in")).toBe("in");
  });

  it("is a new question for another runtime", async () => {
    const cache = new NativeSignInCache();
    expect(await cache.state("a", runtime, async () => "in")).toBe("in");
    expect(await cache.state("a", "/other/antigravity\u00001.5.15", async () => "out")).toBe("out");
  });
});

describe("the record that an instance may hold a sign-in in the CLI's own store", () => {
  it("is the server's, outside the profile, written once and removed on purpose", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "omb-antigravity-held-"));
    scratch.push(baseDir);
    expect(antigravityNativeCredentialsHeld("a", baseDir)).toBe(false);
    noteAntigravityNativeCredentials("a", undefined, baseDir);
    const first = readFileSync(join(baseDir, "providers", "antigravity-native-credentials", (await import("node:fs")).readdirSync(join(baseDir, "providers", "antigravity-native-credentials"))[0]!), "utf8");
    noteAntigravityNativeCredentials("a", undefined, baseDir);
    expect(antigravityNativeCredentialsHeld("a", baseDir)).toBe(true);
    expect(antigravityNativeCredentialsHeld("b", baseDir)).toBe(false);
    expect(first).toContain("since");
    expect(existsSync(join(baseDir, "providers", "antigravity"))).toBe(false);
    clearAntigravityNativeCredentials("a", baseDir);
    expect(antigravityNativeCredentialsHeld("a", baseDir)).toBe(false);
  });

  it("keeps the CLI path the instance last held a sign-in with", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "omb-antigravity-held-"));
    scratch.push(baseDir);
    noteAntigravityNativeCredentials("a", "/opt/antigravity", baseDir);
    expect(antigravityNativeCredentials("a", baseDir)).toMatchObject({ cli: "/opt/antigravity" });
    noteAntigravityNativeCredentials("a", undefined, baseDir);
    expect(antigravityNativeCredentials("a", baseDir)).toMatchObject({ cli: "/opt/antigravity" });
    noteAntigravityNativeCredentials("a", "antigravity", baseDir);
    expect(antigravityNativeCredentials("a", baseDir)).toMatchObject({ cli: "antigravity" });
  });
});
