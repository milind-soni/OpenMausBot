import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpBrowserAuth, type AcpBrowserSignInSpec } from "./browser-auth.ts";

const fakeCli = join(import.meta.dirname, "../../testing/fake-vibe-acp-signin.mjs");

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "acp-browser-auth-"));
}

function spec(overrides: Partial<AcpBrowserSignInSpec> = {}): AcpBrowserSignInSpec {
  return {
    product: "Mistral",
    methodId: (methods) => methods.some((method) => method.id === "browser-auth") ? "browser-auth" : null,
    failure: (stage, detail) => `${stage}${detail ? ` (${detail})` : ""}`,
    ...overrides,
  };
}

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const soon = { timeout: 10_000, interval: 100 };

function makeAuth(home: string, ready: string, mode?: string): AcpBrowserAuth {
  return new AcpBrowserAuth(spec({ args: [fakeCli] }), {
    cli: process.execPath,
    environment: () => ({ ...process.env, HOME: home, FAKE_VIBE_READY: ready, ...(mode ? { FAKE_VIBE_MODE: mode } : {}) }),
    startupTimeoutMs: 30_000,
  });
}

describe.skipIf(process.platform === "win32")("AcpBrowserAuth", () => {
  it("holds authenticate open and succeeds once the readiness probe says signed in", async () => {
    const home = tempHome();
    homes.push(home);
    const ready = join(home, "ready");
    const auth = makeAuth(home, ready);
    const started = await auth.start();
    expect(started).toMatchObject({ phase: "waiting", authorizationUrl: null });
    const status = await auth.get(started.flowId!);
    expect(status.phase).toBe("waiting");
    writeFileSync(ready, "signed-in");
    await expect.poll(async () => (await auth.get(started.flowId!)).phase, soon).toBe("succeeded");
    await auth.dispose();
  });

  it("cancel ends the held flow without success", async () => {
    const home = tempHome();
    homes.push(home);
    const auth = makeAuth(home, join(home, "ready"));
    const started = await auth.start();
    await auth.cancel();
    await expect(auth.get(started.flowId!)).resolves.toMatchObject({ phase: "cancelled" });
    await auth.dispose();
  });

  it("fails with the processEnded stage when the engine exits before answering", async () => {
    const home = tempHome();
    homes.push(home);
    const auth = makeAuth(home, join(home, "ready"), "exit-after-init");
    const started = await auth.start();
    await expect.poll(async () => (await auth.get(started.flowId!)).phase, soon).toBe("failed");
    await auth.dispose();
  });

  it("fails at the start stage when the engine offers no authentication methods", async () => {
    const home = tempHome();
    homes.push(home);
    const auth = makeAuth(home, join(home, "ready"), "no-methods");
    const started = await auth.start();
    await expect.poll(async () => (await auth.get(started.flowId!)).phase, soon).toBe("failed");
    await auth.dispose();
  });

  it("never leaks the engine's own refusal words — the stage decides the message", async () => {
    const home = tempHome();
    homes.push(home);
    const auth = makeAuth(home, join(home, "ready"), "refused");
    const started = await auth.start();
    await expect.poll(async () => (await auth.get(started.flowId!)).phase, soon).toBe("failed");
    const status = await auth.get(started.flowId!);
    expect(JSON.stringify(status)).not.toContain("secret-token-do-not-leak");
    await auth.dispose();
  });

  it("refuses an unknown flow id", async () => {
    const home = tempHome();
    homes.push(home);
    const auth = makeAuth(home, join(home, "ready"));
    await expect(auth.get("no-such-flow")).rejects.toThrow();
    await auth.dispose();
  });

  it("signOut runs the spec's removeCredentials", async () => {
    const home = tempHome();
    homes.push(home);
    const removed: string[] = [];
    const auth = new AcpBrowserAuth(spec({ removeCredentials: (env) => { removed.push(env.HOME!); } }), {
      cli: process.execPath,
      environment: () => ({ ...process.env, HOME: home }),
    });
    await auth.signOut();
    expect(removed).toEqual([home]);
    await auth.dispose();
  });

  it("appends the server hint when the cli path is missing (ENOENT)", async () => {
    const home = tempHome();
    homes.push(home);
    const auth = new AcpBrowserAuth(
      spec({ serverHint: "this sign-in happens on the computer running OpenMausBot" }),
      { cli: join(home, "missing-cli"), environment: () => ({ ...process.env, HOME: home }) },
    );
    // A missing cli reports ENOENT asynchronously, after start has already resolved as waiting.
    const started = await auth.start();
    await expect.poll(async () => (await auth.get(started.flowId!)).phase, soon).toBe("failed");
    const status = await auth.get(started.flowId!);
    expect(status.message).toContain("computer running OpenMausBot");
    await auth.dispose();
  });

  it("reports authenticated through onAuthenticated", async () => {
    const home = tempHome();
    homes.push(home);
    const ready = join(home, "ready");
    let notified: string | null = null;
    const auth = new AcpBrowserAuth(spec({ args: [fakeCli] }), {
      cli: process.execPath,
      environment: () => ({ ...process.env, HOME: home, FAKE_VIBE_READY: ready }),
      startupTimeoutMs: 30_000,
      onAuthenticated: async () => { notified = "yes"; },
    });
    const started = await auth.start();
    writeFileSync(ready, "signed-in");
    await expect.poll(async () => (await auth.get(started.flowId!)).phase, soon).toBe("succeeded");
    expect(notified).toBe("yes");
    await auth.dispose();
  });
});
