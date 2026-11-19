import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listProjectPathEntries } from "./previewFiles.ts";

it("lists file and directory names within the selected registered project", () => {
  const root = mkdtempSync(join(tmpdir(), "gbs-paths-"));
  try {
    const project = join(root, "project");
    const folder = join(project, "TEST · media files");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "Test image.png"), "");
    writeFileSync(join(project, ".env"), "");
    const registry = [{ id: "test", name: "TEST · Project", path: project }];
    expect(listProjectPathEntries(registry, "test", "", "")).toEqual([{ name: "TEST · media files", directory: true }]);
    expect(listProjectPathEntries(registry, "test", "TEST · media files", "IMAGE")).toEqual([{ name: "Test image.png", directory: false }]);
    expect(listProjectPathEntries(registry, "test", "TEST · media files", "other")).toEqual([]);
    expect(() => listProjectPathEntries(registry, "unknown", "", "")).toThrow("Registered project not found");
    expect(() => listProjectPathEntries(registry, "test", "..", "")).toThrow("inside the registered project");
    if (process.platform !== "win32") {
      symlinkSync(root, join(project, "outside"), "dir");
      expect(listProjectPathEntries(registry, "test", "", "outside")).toEqual([]);
      expect(() => listProjectPathEntries(registry, "test", "outside", "")).toThrow("outside the registered project");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
