import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { saveTestingScreenshot } from "./preview-testing-files.ts";
let folder: string;
afterEach(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
it("writes a real PNG to generated evidence names and rejects invalid images", () => {
  folder = mkdtempSync(join(tmpdir(), "gbs-preview-images-"));
  const result = saveTestingScreenshot(png, folder, folder);
  expect(result.ephemeral).toBe(false); expect(result.artifactPath).toContain(".gbs-preview-evidence");
  expect(readFileSync(result.artifactPath)).toEqual(Buffer.from(png, "base64"));
  expect(() => saveTestingScreenshot("aGVsbG8=", folder)).toThrow("PNG");
});
it.skipIf(process.platform === "win32")("refuses a project evidence directory that symlinks outside its project", () => {
  folder = mkdtempSync(join(tmpdir(), "gbs-preview-images-"));
  const project = join(folder, "project"), outside = join(folder, "outside"); mkdirSync(project); mkdirSync(outside);
  symlinkSync(outside, join(project, ".gbs-preview-evidence"));
  expect(() => saveTestingScreenshot(png, folder, project)).toThrow("inside its project");
});
