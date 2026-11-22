import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { insideDataFolder, windowsFolderRefusal } from "./profiles.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omb-profile-routes-")));
afterAll(() => removeTempDir(scratch));

describe("profile folder checks", () => {
  it("takes only a folder on a local drive on Windows", () => {
    for (const folder of ["C:\\Profiles\\acme", "d:/profiles"]) expect(windowsFolderRefusal(folder, "win32")).toBeNull();
    for (const folder of ["\\\\server\\share\\acme", "//server/share/acme", "\\\\?\\C:\\acme", "\\\\.\\C:\\acme", "\\acme", "/acme", "C:acme"]) {
      expect(windowsFolderRefusal(folder, "win32")).toBe("A profile folder must be on a drive of this computer, such as C:\\Profiles.");
    }
    expect(windowsFolderRefusal("/home/me/acme", "linux")).toBeNull();
  });

  it.skipIf(process.platform === "win32")("finds a folder inside the data folder through a link on either side", () => {
    const data = join(scratch, "data");
    mkdirSync(join(data, "acme"), { recursive: true });
    mkdirSync(join(scratch, "elsewhere"));
    symlinkSync(join(data, "acme"), join(scratch, "into-data"));
    symlinkSync(data, join(scratch, "data-link"));
    expect(insideDataFolder([join(scratch, "elsewhere")], data)).toBe(false);
    expect(insideDataFolder([data], data)).toBe(true);
    expect(insideDataFolder([realpathSync(join(scratch, "into-data"))], data)).toBe(true);
    expect(insideDataFolder([join(data, "acme")], join(scratch, "data-link"))).toBe(true);
  });
});
