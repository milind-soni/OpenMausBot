// What these tests pin about the built-in browser: which BetterWright profile
// a bot lands in (its own session, a shared named one, or the throwaway
// guest), the exact process spawned for the MCP integration, and that erasing
// a profile can only ever delete inside BetterWright's own profiles folder.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import {
  betterwrightCliPath,
  browserIntegrationSpec,
  browserProfileName,
  createBrowserProvisioner,
  forgetBrowserProfile,
} from "./betterwright.ts";

const temporaryHomes: string[] = [];

function betterwrightHome(): string {
  const home = mkdtempSync(join(tmpdir(), "omb-betterwright-"));
  temporaryHomes.push(home);
  return home;
}

afterAll(async () => {
  for (const home of temporaryHomes) await removeTempDir(home);
});

describe("built-in browser profiles", () => {
  const cfg = {
    browserProfiles: [
      { id: "work", name: "Work" },
      { id: "shop", name: "Shop", partitionId: "Shop-2" },
    ],
  };

  it("gives a bot with no chosen profile its own session", () => {
    expect(browserProfileName("b1", undefined, cfg)).toBe("bot-b1");
    expect(browserProfileName("b1", "", cfg)).toBe("bot-b1");
  });

  it("routes a named profile to its durable partition, not its config id", () => {
    expect(browserProfileName("b1", "work", cfg)).toBe("work");
    expect(browserProfileName("b1", "shop", cfg)).toBe("Shop-2");
  });

  it("keeps guest a throwaway shared with nobody's account", () => {
    expect(browserProfileName("b1", "guest", cfg)).toBe("guest");
  });

  it("falls back to the bot's own session when the profile was deleted", () => {
    expect(browserProfileName("b1", "gone", cfg)).toBe("bot-b1");
    expect(browserProfileName("b1", "work", { browserProfiles: [] })).toBe("bot-b1");
  });
});

describe("built-in browser integration", () => {
  it("spawns the betterwright MCP server for the mapped profile", () => {
    const cli = betterwrightCliPath();
    expect(cli).toMatch(/betterwright\.js$/);
    const spec = browserIntegrationSpec("bot-b1");
    expect(spec).toEqual({
      command: process.execPath,
      args: [cli, "mcp"],
      env: { ELECTRON_RUN_AS_NODE: "1", BETTERWRIGHT_PROFILE: "bot-b1" },
    });
  });
});

describe("provisioning the managed browser", () => {
  // The suite-wide OMB_BETTERWRIGHT_PROVISION=off guard exists for harness
  // boots with the real runner; these tests inject fakes, so lift it.
  const withProvisioning = async (body: () => Promise<void>) => {
    const previous = process.env.OMB_BETTERWRIGHT_PROVISION;
    delete process.env.OMB_BETTERWRIGHT_PROVISION;
    try {
      await body();
    } finally {
      if (previous === undefined) delete process.env.OMB_BETTERWRIGHT_PROVISION;
      else process.env.OMB_BETTERWRIGHT_PROVISION = previous;
    }
  };

  it("does not run setup when the browser is already usable", () =>
    withProvisioning(async () => {
      const calls: string[][] = [];
      const provisioner = createBrowserProvisioner(async (args) => {
        calls.push(args);
        return { ok: true, stdout: "" };
      });
      await expect(provisioner.ensure()).resolves.toBe(true);
      expect(calls).toEqual([["mcp", "--check"]]);
    }));

  it("runs setup once on a clean machine and shares the attempt", () =>
    withProvisioning(async () => {
      const calls: string[][] = [];
      const provisioner = createBrowserProvisioner(async (args) => {
        calls.push(args);
        // first check fails (no browser); setup and the re-check succeed
        return { ok: !(args[1] === "--check" && calls.length === 1), stdout: "" };
      });
      const [first, second] = await Promise.all([provisioner.ensure(), provisioner.ensure()]);
      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(calls).toEqual([["mcp", "--check"], ["setup"], ["mcp", "--check"]]);
      // a settled success is cached — no further processes
      await expect(provisioner.ensure()).resolves.toBe(true);
      expect(calls.length).toBe(3);
    }));

  it("retries a failed attempt instead of caching it", () =>
    withProvisioning(async () => {
      let attempts = 0;
      const provisioner = createBrowserProvisioner(async (args) => {
        if (args[0] === "setup") attempts += 1;
        // setup keeps failing (offline); the second attempt succeeds
        return { ok: attempts >= 2, stdout: "" };
      });
      await expect(provisioner.ensure()).resolves.toBe(false);
      await expect(provisioner.ensure()).resolves.toBe(true);
      expect(attempts).toBe(2);
    }));

  it("stays inert while the test-suite guard is set", async () => {
    process.env.OMB_BETTERWRIGHT_PROVISION = "off";
    const provisioner = createBrowserProvisioner(async () => {
      throw new Error("must not spawn");
    });
    await expect(provisioner.ensure()).resolves.toBe(false);
  });
});

describe("forgetting a browser profile", () => {
  it("erases the profile directory and nothing above it", async () => {
    const home = betterwrightHome();
    const profiles = join(home, "browser", "profiles");
    mkdirSync(join(profiles, "bot-b1"), { recursive: true });
    writeFileSync(join(profiles, "bot-b1", "Cookies"), "session");
    mkdirSync(join(profiles, "bot-b1.betterwright-lock"), { recursive: true });
    const previousHome = process.env.BETTERWRIGHT_HOME;
    process.env.BETTERWRIGHT_HOME = home;
    try {
      await forgetBrowserProfile("bot-b1", [0]);
      expect(existsSync(join(profiles, "bot-b1"))).toBe(false);
      expect(existsSync(join(profiles, "bot-b1.betterwright-lock"))).toBe(false);
      expect(existsSync(profiles)).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.BETTERWRIGHT_HOME;
      else process.env.BETTERWRIGHT_HOME = previousHome;
    }
  });

  it("stops retrying once the erased state stays gone", async () => {
    const home = betterwrightHome();
    const profiles = join(home, "browser", "profiles");
    mkdirSync(join(profiles, "bot-b2"), { recursive: true });
    const previousHome = process.env.BETTERWRIGHT_HOME;
    process.env.BETTERWRIGHT_HOME = home;
    try {
      // A later pass whose delay never elapsed would hang this test; the
      // stability check must return right after the first clean re-check.
      await forgetBrowserProfile("bot-b2", [0, 0, 60_000]);
      expect(existsSync(join(profiles, "bot-b2"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.BETTERWRIGHT_HOME;
      else process.env.BETTERWRIGHT_HOME = previousHome;
    }
  });

  it("refuses a name that would escape the profiles directory", async () => {
    const home = betterwrightHome();
    const profiles = join(home, "browser", "profiles");
    const sibling = join(home, "browser", "keep");
    mkdirSync(profiles, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const previousHome = process.env.BETTERWRIGHT_HOME;
    process.env.BETTERWRIGHT_HOME = home;
    try {
      await forgetBrowserProfile("../keep", [0]);
      await forgetBrowserProfile("..", [0]);
      expect(existsSync(sibling)).toBe(true);
      expect(existsSync(profiles)).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.BETTERWRIGHT_HOME;
      else process.env.BETTERWRIGHT_HOME = previousHome;
    }
  });
});
