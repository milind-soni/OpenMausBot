import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  claudeApiKeyHelperChildEnv,
  isClaudeApiKeyHelperEntrypoint,
  readClaudeApiKey,
} from "./claude-api-key-helper.ts";

describe("Claude bare-mode API key helper", () => {
  it("rejects malformed credential aliases", () => {
    for (const value of [undefined, "", "../../credential", "/etc/shadow", "alias with spaces", "alias\nnext"]) {
      expect(() => readClaudeApiKey(value)).toThrow(/alias is invalid/);
    }
  });

  it("passes a well-formed alias to CredVault", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "a-valid-injected-credential", error: undefined }));
    expect(readClaudeApiKey("anthropic/console", run as unknown as typeof import("node:child_process").spawnSync)).toBe(
      "a-valid-injected-credential",
    );
    expect(run).toHaveBeenCalledWith(
      "credvault",
      expect.arrayContaining(["exec", "anthropic/console", "ANTHROPIC_API_KEY"]),
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("recognizes resolved entrypoint paths and rejects missing ones", () => {
    const modulePath = realpathSync(new URL("./claude-api-key-helper.ts", import.meta.url));
    expect(isClaudeApiKeyHelperEntrypoint(modulePath, modulePath)).toBe(true);
    expect(isClaudeApiKeyHelperEntrypoint(relative(process.cwd(), modulePath), modulePath)).toBe(true);
    expect(isClaudeApiKeyHelperEntrypoint("/definitely/missing/helper.ts", modulePath)).toBe(false);
  });

  it("re-executes a packaged Electron binary in Node mode", () => {
    expect(claudeApiKeyHelperChildEnv({ PATH: "/safe/bin", HOME: "/safe/home" })).toEqual({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });
});
