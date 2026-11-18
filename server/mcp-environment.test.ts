import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { mcpCommandEnvironment, writableCache } from "./mcp-environment.ts";

describe("the npm cache an MCP command gets", () => {
  it("swaps a cache the server cannot write for its own, whatever the variable's case", () => {
    const env = mcpCommandEnvironment({ NPM_CONFIG_CACHE: "/data/.npm", PATH: "/bin" }, {}, () => false);
    expect(env.NPM_CONFIG_CACHE).toBeUndefined();
    expect(env.npm_config_cache).toContain("openmausbot-mcp-npm-");
    expect(env.PATH).toBe("/bin");
    expect(mcpCommandEnvironment({ HOME: "/data", LOCALAPPDATA: "C:\\data" }, {}, () => false).npm_config_cache).toContain("openmausbot-mcp-npm-");
  });

  it("keeps a cache that works, and a server's own setting always wins", () => {
    expect(mcpCommandEnvironment({ npm_config_cache: "/home/me/.npm" }, {}, () => true).npm_config_cache).toBe("/home/me/.npm");
    expect(mcpCommandEnvironment({ npm_config_cache: "/data/.npm" }, { npm_config_cache: "/srv/cache" }, () => false).npm_config_cache).toBe("/srv/cache");
  });

  it("counts a cache that does not exist yet as writable when its nearest folder is", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-npm-home-"));
    try {
      expect(writableCache(join(home, ".npm"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
