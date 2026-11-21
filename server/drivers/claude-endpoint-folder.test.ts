import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEndpointFolder } from "./claude-endpoint-folder.ts";

describe("withEndpointFolder", () => {
  let scratch = "";
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "omb-endpoint-folder-")); });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("makes a missing custom endpoint folder, wherever it lives", () => {
    const dir = join(scratch, "providers", "claude-endpoint");
    const env = { CLAUDE_CONFIG_DIR: dir };
    expect(withEndpointFolder(env, { endpointModels: ["glm-test"], configDir: dir })).toBe(env);
    expect(existsSync(dir)).toBe(true);
  });

  it("leaves Claude accounts and the default Claude alone", () => {
    const dir = join(scratch, "providers", "claude-account");
    withEndpointFolder({ CLAUDE_CONFIG_DIR: dir }, { configDir: dir });
    expect(existsSync(dir)).toBe(false);
  });

  it("runs onFail before rethrowing a failed mkdir", () => {
    const file = join(scratch, "not-a-folder");
    writeFileSync(file, "");
    const dir = join(file, "claude-endpoint");
    const onFail = vi.fn();
    expect(() => withEndpointFolder({ CLAUDE_CONFIG_DIR: dir }, { endpointModels: ["glm-test"], configDir: dir }, onFail)).toThrow();
    expect(onFail).toHaveBeenCalledOnce();
  });
});
