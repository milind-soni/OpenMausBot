// Every subprocess here is a local fake script in a disposable HOME: no real provider, network or credentials.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { DeviceAuthController, type DeviceSignIn } from "./device-auth.ts";

const FAKE = `#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME;
const args = process.argv.slice(2);
appendFileSync(join(home, 'calls.jsonl'), JSON.stringify({ args }) + '\\n');
if (args.join(' ') === 'logout') {
  writeFileSync(join(home, 'logout.pid'), String(process.pid));
  if (process.env.FAKE_AUTH_MODE === 'logout-fails') { console.error('error: could not remove credentials'); process.exit(1); }
  const had = existsSync(join(home, '.fake-provider', 'auth.json'));
  try { unlinkSync(join(home, '.fake-provider', 'auth.json')); } catch {}
  console.error(had ? 'Signed out' : 'Not signed in');
  process.exit(0);
}
process.exit(4);
`;

function spec(logoutArgs?: readonly string[], overrides: Partial<DeviceSignIn> = {}): DeviceSignIn {
  return {
    provider: "grok",
    product: "Fake",
    account: "Fake",
    homeEnv: "FAKE_PROVIDER_HOME",
    homeDir: ".fake-provider",
    loginArgs: ["login"],
    install: "install hint",
    failure: () => "Fake sign-in did not finish.",
    signedIn: (env) => existsSync(join(env.FAKE_PROVIDER_HOME || join(env.HOME || env.USERPROFILE || "", ".fake-provider"), "auth.json")),
    ...(logoutArgs ? { logoutArgs } : {}),
    ...overrides,
  };
}

describe("device sign-out without a status command", () => {
  let home: string;
  let cli: string;
  let controllers: DeviceAuthController[];
  const create = (logoutArgs?: readonly string[], mode?: string, overrides: Partial<DeviceSignIn> = {}) => {
    const controller = new DeviceAuthController(spec(logoutArgs, overrides), {
      cli, terminateTimeoutMs: 50,
      environment: () => ({
        ...process.env, HOME: home, USERPROFILE: home, FAKE_PROVIDER_HOME: join(home, ".fake-provider"),
        ...(mode ? { FAKE_AUTH_MODE: mode } : {}),
      }),
    });
    controllers.push(controller);
    return controller;
  };
  const calls = () => existsSync(join(home, "calls.jsonl"))
    ? readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[] })
    : [];
  const signedIn = () => {
    mkdirSync(join(home, ".fake-provider"), { recursive: true });
    writeFileSync(join(home, ".fake-provider", "auth.json"), "{}", { mode: 0o600 });
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omb-device-signout-"));
    cli = join(home, "fake-provider.mjs");
    writeFileSync(cli, FAKE, { mode: 0o700 });
    chmodSync(cli, 0o700);
    controllers = [];
  });
  afterEach(async () => {
    await Promise.all(controllers.map((controller) => controller.dispose()));
    await removeTempDir(home);
  });

  it("reads the stored sign-in through the spec, runs the CLI's logout, and confirms it is gone", async () => {
    signedIn();
    const controller = create(["logout"]);
    await controller.signOut();
    expect(existsSync(join(home, ".fake-provider", "auth.json"))).toBe(false);
    expect(calls().map((call) => call.args)).toEqual([["logout"]]);
    await controller.signOut();
    expect(calls().map((call) => call.args)).toEqual([["logout"]]);
  });

  it("returns without running the logout when nothing is signed in", async () => {
    const controller = create(["logout"]);
    await controller.signOut();
    expect(calls()).toEqual([]);
  });

  it("says plainly when the CLI could not remove the sign-in", async () => {
    signedIn();
    const controller = create(["logout"], "logout-fails");
    await expect(controller.signOut()).rejects.toThrow("Fake could not remove the sign-in on this server.");
    expect(existsSync(join(home, ".fake-provider", "auth.json"))).toBe(true);
  });

  it("stays unavailable for a provider without a logout command", async () => {
    signedIn();
    await expect(create(undefined).signOut()).rejects.toThrow("Signing out of Fake is not available from here.");
    expect(calls()).toEqual([]);
  });

  it("removes the stored sign-in without a CLI command when the spec removes credentials itself", async () => {
    signedIn();
    const controller = create(undefined, undefined, { removeCredentials: (env) => {
      unlinkSync(join(env.FAKE_PROVIDER_HOME || join(env.HOME || env.USERPROFILE || "", ".fake-provider"), "auth.json"));
    } });
    await controller.signOut();
    expect(existsSync(join(home, ".fake-provider", "auth.json"))).toBe(false);
    expect(calls()).toEqual([]);
  });

  it("refuses to sign out when the sign-in cannot be read, instead of reporting a removal that never happened", async () => {
    signedIn();
    const controller = create(undefined, undefined, {
      removeCredentials: () => unlinkSync(join(home, ".fake-provider", "auth.json")),
      signInState: () => "unknown",
    });
    await expect(controller.signOut()).rejects.toThrow("Fake did not confirm a Fake sign-in.");
    expect(existsSync(join(home, ".fake-provider", "auth.json"))).toBe(true);
  });
});
