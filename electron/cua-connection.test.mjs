import { createRequire } from "node:module";
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");

describe("CUA connection persistence", () => {
  it("keeps the previous in-memory and on-disk descriptor when replacement fails", () => {
    const userData = mkdtempSync(path.join(os.tmpdir(), "omb-cua-connection-"));
    try {
      let failReplacement = false;
      const fileSystem = {
        ...fs,
        renameSync(from, to) {
          if (failReplacement) throw new Error("simulated replacement failure");
          fs.renameSync(from, to);
        },
      };
      const store = createCuaConnectionStore({
        getUserData: () => userData,
        fileSystem,
        temporaryId: () => "test",
        processId: 123,
      });
      const previous = { mode: "standalone", mcpCommand: "cua-driver", mcpArgs: ["mcp"] };
      const next = { mode: "unavailable", reason: "driver stopped" };

      expect(store.persist(previous)).toEqual(previous);
      failReplacement = true;

      expect(() => store.persist(next)).toThrow("simulated replacement failure");
      expect(store.get()).toEqual(previous);
      expect(
        JSON.parse(fs.readFileSync(path.join(userData, "cua-connection.json"), "utf8")),
      ).toEqual(previous);
      expect(
        fs.existsSync(path.join(userData, "cua-connection.json.123.test.tmp")),
      ).toBe(false);
      // Keep replacement/rollback coverage on Windows, where Node accepts
      // chmod but NTFS does not expose the requested POSIX mode bits.
      if (process.platform !== "win32") {
        expect(fs.statSync(path.join(userData, "cua-connection.json")).mode & 0o777).toBe(0o600);
        expect(fs.statSync(userData).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
