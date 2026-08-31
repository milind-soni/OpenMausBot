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

describe("forgetting a browser profile", () => {
  it("erases the profile directory and nothing above it", async () => {
    const home = betterwrightHome();
    const profiles = join(home, "browser", "profiles");
    mkdirSync(join(profiles, "bot-b1"), { recursive: true });
    writeFileSync(join(profiles, "bot-b1", "Cookies"), "session");
    const previousHome = process.env.BETTERWRIGHT_HOME;
    process.env.BETTERWRIGHT_HOME = home;
    try {
      await forgetBrowserProfile("bot-b1");
      expect(existsSync(join(profiles, "bot-b1"))).toBe(false);
      expect(existsSync(profiles)).toBe(true);
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
      await forgetBrowserProfile("../keep");
      await forgetBrowserProfile("..");
      expect(existsSync(sibling)).toBe(true);
      expect(existsSync(profiles)).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.BETTERWRIGHT_HOME;
      else process.env.BETTERWRIGHT_HOME = previousHome;
    }
  });
});
