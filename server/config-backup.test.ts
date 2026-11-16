import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONFIG_BACKUP_KEEP,
  configSaveRefusal,
  listConfigBackups,
  readConfigFile,
  restoreConfigBackup,
  writeConfigBackup,
} from "./config-backup.ts";

const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "omb-config-backup-")); dirs.push(dir); return dir; };
const configPath = (dir: string) => join(dir, "config.json");
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("reading the settings file", () => {
  it("tells a file that is not there from one that cannot be read", () => {
    const dir = tempDir();
    expect(readConfigFile(configPath(dir))).toEqual({ state: "missing" });
    mkdirSync(configPath(dir));
    expect(readConfigFile(configPath(dir)).state).toBe("unreadable");
  });

  it("tells a file that is not a settings file from one that is", () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), "{ not json");
    expect(readConfigFile(configPath(dir)).state).toBe("invalid");
    writeFileSync(configPath(dir), "[1,2]");
    expect(readConfigFile(configPath(dir)).state).toBe("invalid");
    writeFileSync(configPath(dir), JSON.stringify({ mcpServers: { notes: {} } }));
    const read = readConfigFile(configPath(dir));
    expect(read.state).toBe("ok");
    expect(read.state === "ok" && read.value.mcpServers).toEqual({ notes: {} });
  });
});

describe("a save that cannot read the file", () => {
  it("refuses to replace it and says how to recover", () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), "{ not json");
    const read = readConfigFile(configPath(dir));
    expect(read.state).toBe("invalid");
    const error = configSaveRefusal(read as { state: string; reason: string }, configPath(dir));
    expect((error as { status?: number }).status).toBe(503);
    expect(error.message).toContain(configPath(dir));
    expect(error.message).toContain("openmausbot config restore");
  });

  it("keeps the bytes of a file it could not understand", () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), "{ not json");
    const read = readConfigFile(configPath(dir));
    configSaveRefusal(read as { state: string; reason: string }, configPath(dir));
    const aside = readdirSync(dir).filter((name) => name.startsWith("config.json.unreadable-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!), "utf8")).toBe("{ not json");
  });
});

describe("the dated copies", () => {
  it("hold the file as it was", () => {
    const dir = tempDir();
    const name = writeConfigBackup(configPath(dir), "{\"a\":1}", new Date("2026-11-16T00:30:00Z"));
    expect(name).toBe("config.json.bak.20261116-003000");
    expect(readFileSync(join(dir, name!), "utf8")).toBe("{\"a\":1}");
    expect(statSync(join(dir, name!)).mode & 0o777).toBe(0o600);
  });

  it("do not overwrite each other within a second", () => {
    const dir = tempDir();
    const now = new Date("2026-11-16T00:30:00Z");
    expect(writeConfigBackup(configPath(dir), "one", now)).toBe("config.json.bak.20261116-003000");
    expect(writeConfigBackup(configPath(dir), "two", now)).toBe("config.json.bak.20261116-003000-1");
  });

  it("keep only the newest ones", () => {
    const dir = tempDir();
    for (let second = 0; second < CONFIG_BACKUP_KEEP + 4; second += 1) {
      writeConfigBackup(configPath(dir), `copy ${second}`, new Date(Date.UTC(2026, 10, 16, 0, 0, second)));
    }
    const copies = listConfigBackups(dir);
    expect(copies).toHaveLength(CONFIG_BACKUP_KEEP);
    expect(copies[copies.length - 1]!.name).toBe("config.json.bak.20261116-000013");
  });

  it("are listed oldest first", () => {
    const dir = tempDir();
    writeConfigBackup(configPath(dir), "a", new Date("2026-11-16T00:00:00Z"));
    writeConfigBackup(configPath(dir), "b", new Date("2026-11-16T01:00:00Z"));
    expect(listConfigBackups(dir).map((copy) => copy.stamp)).toEqual(["20261116-000000", "20261116-010000"]);
  });
});

describe("putting a copy back", () => {
  it("makes it the settings file again", () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), JSON.stringify({ old: true }, null, 2));
    const name = writeConfigBackup(configPath(dir), readFileSync(configPath(dir), "utf8"));
    writeFileSync(configPath(dir), JSON.stringify({ new: true }));
    expect(restoreConfigBackup(dir, name!).ok).toBe(true);
    expect(readFileSync(configPath(dir), "utf8")).toBe(JSON.stringify({ old: true }, null, 2));
  });

  it("keeps the file it replaces, so the restore is reversible", () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), JSON.stringify({ old: true }));
    const name = writeConfigBackup(configPath(dir), readFileSync(configPath(dir), "utf8"));
    writeFileSync(configPath(dir), JSON.stringify({ new: true }));
    const restored = restoreConfigBackup(dir, name!);
    expect(restored.ok && restored.kept).toBeTruthy();
    expect(JSON.parse(readFileSync((restored as { kept: string }).kept, "utf8"))).toEqual({ new: true });
  });

  it("never overwrites the copy it restores from", () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), JSON.stringify({ old: true }));
    const name = writeConfigBackup(configPath(dir), readFileSync(configPath(dir), "utf8"), new Date("2026-11-16T00:30:00Z"));
    writeFileSync(configPath(dir), JSON.stringify({ new: true }));
    const restored = restoreConfigBackup(dir, name!);
    expect(restored.ok && restored.kept).toBeTruthy();
    expect(readFileSync(join(dir, name!), "utf8")).toBe(JSON.stringify({ old: true }));
    expect((restored as { kept: string }).kept).not.toBe(join(dir, name!));
  });

  it("keeps a settings file it could not understand", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "config.json.bak.20261116-003000"), JSON.stringify({ old: true }));
    writeFileSync(configPath(dir), "{ not json");
    const restored = restoreConfigBackup(dir, "config.json.bak.20261116-003000");
    expect(restored.ok && restored.kept).toBeTruthy();
    expect(readFileSync((restored as { kept: string }).kept, "utf8")).toBe("{ not json");
    expect(JSON.parse(readFileSync(configPath(dir), "utf8"))).toEqual({ old: true });
  });

  it("changes nothing in a dry run", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "config.json.bak.20261116-003000"), JSON.stringify({ old: true }));
    writeFileSync(configPath(dir), JSON.stringify({ new: true }));
    const restored = restoreConfigBackup(dir, "config.json.bak.20261116-003000", { dryRun: true });
    expect(restored.ok && restored.restored).toBe(false);
    expect(readFileSync(configPath(dir), "utf8")).toBe(JSON.stringify({ new: true }));
  });

  it("refuses a copy that is not a settings file, and a name that is not a copy", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "config.json.bak.20261116-003000"), "{ not json");
    expect(restoreConfigBackup(dir, "config.json.bak.20261116-003000").ok).toBe(false);
    expect(restoreConfigBackup(dir, "../secret").ok).toBe(false);
    expect(restoreConfigBackup(dir, "/etc/passwd").ok).toBe(false);
  });
});
