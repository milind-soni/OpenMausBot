import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { browserRoot, compareVersions, downgradeRefusal, ensureProfile, markCleanExit, profileDir, profileHash, recordOpenedBy, versionOf, workspaceId } from "./profile.ts";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-chrome-test-"));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

describe("profiles", () => {
  it("gives each workspace its own random id and each key its own folder", () => {
    const data = scratch();
    const id = workspaceId(data);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(workspaceId(data)).toBe(id);
    expect(workspaceId(scratch())).not.toBe(id);
    expect(profileHash(id, "bot:alice")).toHaveLength(24);
    expect(profileHash(id, "bot:alice")).not.toBe(profileHash(id, "bot:bob"));
    expect(profileDir(data, "bot:alice")).toBe(join(browserRoot(data), "profiles", profileHash(id, "bot:alice")));
    expect(profileDir(data, "temp:alice:run1")).toContain(join("browser", "temp"));
    expect(() => profileDir(data, "nonsense")).toThrow(/profile key/);
  });

  it("writes quiet preferences at creation and refreshes the language when reopening", () => {
    const data = scratch();
    const made = ensureProfile(data, "bot:alice", { acceptLanguages: "en-IN,en", now: () => new Date("2026-10-15T00:00:00Z") });
    expect(made.created).toBe(true);
    const preferences = JSON.parse(readFileSync(join(made.dir, "Default", "Preferences"), "utf8"));
    expect(preferences).toMatchObject({
      session: { restore_on_startup: 1 },
      credentials_enable_service: false,
      profile: { password_manager_enabled: false },
      autofill: { profile_enabled: false, credit_card_enabled: false },
      signin: { allowed: false },
      translate: { enabled: false },
      intl: { accept_languages: "en-IN,en" },
    });
    expect(made.record).toMatchObject({ key: "bot:alice", backend: "local", egress: "direct", chromeVersion: null, createdAt: "2026-10-15T00:00:00.000Z" });
    writeFileSync(join(made.dir, "Default", "Preferences"), JSON.stringify({ ...preferences, profile: { ...preferences.profile, exit_type: "Crashed" }, extra: 1 }));
    expect(ensureProfile(data, "bot:alice", { acceptLanguages: "ko-KR,ko,en-US,en" }).created).toBe(false);
    markCleanExit(made.dir);
    const after = JSON.parse(readFileSync(join(made.dir, "Default", "Preferences"), "utf8"));
    expect(after).toMatchObject({ extra: 1, profile: { exit_type: "Normal", exited_cleanly: true, password_manager_enabled: false }, intl: { accept_languages: "ko-KR,ko,en-US,en" } });
  });

  it("refuses to let an older Chrome open a profile a newer one wrote", () => {
    const data = scratch();
    const { dir, record } = ensureProfile(data, "bot:alice");
    expect(downgradeRefusal(record, "150.0.1.2")).toBeNull();
    recordOpenedBy(dir, "153.0.8010.12");
    recordOpenedBy(dir, "152.0.1.1");
    const opened = ensureProfile(data, "bot:alice").record;
    expect(opened.chromeVersion).toBe("153.0.8010.12");
    expect(downgradeRefusal(opened, "153.0.8010.12")).toBeNull();
    expect(downgradeRefusal(opened, "153.0.8010.9")).toMatch(/older/);
    expect(compareVersions("153.0.10.0", "153.0.9.9")).toBe(1);
    expect(versionOf("Chrome/153.0.8010.12")).toBe("153.0.8010.12");
  });
});
