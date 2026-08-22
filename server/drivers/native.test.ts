// The native tee is the file people paste into bug reports, so the wiring
// that keeps credentials out of it is tested at the writer — redact.test.ts
// covers the masking function, this covers that appendNative actually calls it.
// (server/testing/setup.ts points HOME at a throwaway dir, so NATIVE_DIR is
// already isolated from the real fleet.)
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import { invalidateProtectedEnvironmentRedactor } from "../redact.ts";
import { appendNative } from "./native.ts";

beforeAll(() => ensureDirs());

describe("appendNative", () => {
  it("masks the tokens an ACP session/new hands the agent", () => {
    appendNative("t-native", {
      dir: "out",
      source: "acp",
      msg: {
        method: "session/new",
        params: {
          mcpServers: [
            {
              name: "computer",
              env: [
                { name: "OGB_BOX_ID", value: "box-7" },
                { name: "OGB_BOX_TOKEN", value: "box_live_dontlogme" },
              ],
            },
          ],
        },
      },
    });

    const log = readFileSync(join(NATIVE_DIR, "t-native.ndjson"), "utf8");
    expect(log).not.toContain("box_live_dontlogme");
    // the shape a debugger needs is still there: which server, which var
    expect(log).toContain("session/new");
    expect(log).toContain("OGB_BOX_TOKEN");
    expect(log).toContain("box-7");
  });

  it("writes the log private to the user", () => {
    appendNative("t-mode", { dir: "in", source: "acp", msg: { hello: "world" } });
    const mode = statSync(join(NATIVE_DIR, "t-mode.ndjson")).mode & 0o777;
    // Windows does not implement POSIX modes; everywhere else, owner-only
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("masks an exact protected canary even when it has no recognizable prefix", () => {
    const canary = "native-canary-value-193746";
    process.env.NATIVE_TEST_SECRET = canary;
    invalidateProtectedEnvironmentRedactor();
    try {
      appendNative("t-known", { dir: "in", source: "codex", msg: { text: `copied ${canary}` } });
      const log = readFileSync(join(NATIVE_DIR, "t-known.ndjson"), "utf8");
      expect(log).not.toContain(canary);
      expect(log).toContain("redacted");
    } finally {
      delete process.env.NATIVE_TEST_SECRET;
      invalidateProtectedEnvironmentRedactor();
    }
  });

  it("never throws, whatever it is handed", () => {
    expect(() => appendNative("t-bad", { dir: "in", source: "acp", msg: undefined })).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => appendNative("t-cyclic", { dir: "in", source: "acp", msg: cyclic })).not.toThrow();
  });
});
