import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_BACKUP_KEEP, listConfigBackups, restoreConfigBackup, writeConfigBackup } from "./config-backup.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-backup-clock-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  const names = Array.from({ length: CONFIG_BACKUP_KEEP }, (_, i) => writeConfigBackup(path, JSON.stringify({ saved: i }), new Date(Date.UTC(2099, 0, 1, 0, 0, i)))!);
  return { dir, path, names };
}

describe("config rollback copies after a clock correction", () => {
  it("keeps the just-written copy even when its timestamp sorts before every old copy", () => {
    const { dir, path, names } = fixture();
    const text = JSON.stringify({ apiKey: "fixture-current-key", settings: "current" });
    const name = writeConfigBackup(path, text, new Date("2026-11-17T00:00:00Z"));
    expect(name).toBeTruthy();
    expect(existsSync(join(dir, name!))).toBe(true);
    expect(readFileSync(join(dir, name!), "utf8")).toBe(text);
    expect(listConfigBackups(dir)).toHaveLength(CONFIG_BACKUP_KEEP);
    expect(existsSync(join(dir, names[0]!))).toBe(false);
    expect(existsSync(join(dir, names.at(-1)!))).toBe(true);
  });

  it("returns a real undo copy when restoring among future-dated backups", () => {
    const { dir, path, names } = fixture();
    const current = JSON.stringify({ apiKey: "fixture-current-key", settings: "before restore" });
    writeFileSync(path, current);
    const restored = restoreConfigBackup(dir, names.at(-1)!);
    expect(restored.ok).toBe(true);
    if (!restored.ok || !restored.kept) throw new Error("expected the replaced settings to be kept");
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ saved: CONFIG_BACKUP_KEEP - 1 }));
    expect(existsSync(restored.kept)).toBe(true);
    expect(readFileSync(restored.kept, "utf8")).toBe(current);
    expect(listConfigBackups(dir)).toHaveLength(CONFIG_BACKUP_KEEP);
  });

  it("keeps each current rollback copy and the retention bound across repeated backward saves", () => {
    const { dir, path } = fixture();
    for (let day = 20; day >= 17; day--) {
      const text = JSON.stringify({ revision: day });
      const name = writeConfigBackup(path, text, new Date(Date.UTC(2026, 10, day)));
      expect(existsSync(join(dir, name!))).toBe(true);
      expect(readFileSync(join(dir, name!), "utf8")).toBe(text);
      expect(listConfigBackups(dir)).toHaveLength(CONFIG_BACKUP_KEEP);
    }
  });

  it("still removes the oldest existing copy when the clock advances", () => {
    const { dir, path, names } = fixture();
    const name = writeConfigBackup(path, "latest", new Date("2100-01-01T00:00:00Z"));
    expect(readFileSync(join(dir, name!), "utf8")).toBe("latest");
    expect(existsSync(join(dir, names[0]!))).toBe(false);
    expect(listConfigBackups(dir)).toHaveLength(CONFIG_BACKUP_KEEP);
  });
});
