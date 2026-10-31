import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { configuredWebSearch, privateSearchAddress, searxngBase, webSearchStatus } from "./web-search-config.ts";
import { loadConfig, parseConfigPatch, saveConfig, syncCredentialEnv, instanceConfigs, DATA_DIR } from "./config.ts";
import { stripWorkspaceCredentialEnv } from "./credential-env.ts";

afterEach(() => vi.unstubAllEnvs());
describe("web search configuration", () => {
  it("selects only configured backends and never includes the Brave key in status or engines", () => {
    const config = { braveApiKey: "synthetic-secret", searxngUrl: "https://search.example/" };
    expect(configuredWebSearch()).toBeNull();
    expect(configuredWebSearch({ braveApiKey: "key" })).toBe("brave");
    expect(configuredWebSearch(config)).toBe("searxng");
    expect(JSON.stringify(webSearchStatus(config))).not.toContain(config.braveApiKey);
    expect(JSON.stringify(instanceConfigs({ ...loadConfig(), webSearch: config }))).not.toContain(config.braveApiKey);
  });
  it("persists settings, supports partial updates and synchronizes the environment key", () => {
    vi.stubEnv("OMB_BRAVE_SEARCH_API_KEY", "");
      saveConfig({ webSearch: { searxngUrl: "http://127.0.0.1:9876", braveApiKey: "synthetic-key" } });
      saveConfig({ webSearch: { searxngUrl: "" } });
      expect(JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8")).webSearch).toEqual({ searxngUrl: "", braveApiKey: "synthetic-key" });
      syncCredentialEnv({ webSearch: { braveApiKey: "synthetic-key" } });
      expect(loadConfig().webSearch).toEqual({ searxngUrl: "", braveApiKey: "synthetic-key" });
      syncCredentialEnv({ webSearch: { braveApiKey: "" } });
      expect(process.env.OMB_BRAVE_SEARCH_API_KEY).toBeUndefined();
  });
  it.each(["ftp://example.com", "https://user:pass@example.com", "https://example.com?q=x", "https://example.com#x", "https://example.com?", "https://example.com#", "invalid"])("rejects invalid owner URL %s", searxngUrl => {
    expect(() => parseConfigPatch({ webSearch: { searxngUrl } })).toThrow();
  });
  it("preserves base paths and restricts the HTTP private exception", () => {
    expect(searxngBase("https://example.com/prefix").href).toBe("https://example.com/prefix/");
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "::1", "fd12::1"]) expect(privateSearchAddress(ip), ip).toBe(true);
    for (const ip of ["169.254.169.254", "93.184.216.34", "::ffff:127.0.0.1", "64:ff9b::a00:1", "0.0.0.0"]) expect(privateSearchAddress(ip), ip).toBe(false);
  });
  it("strips every letter casing of the search key from child environments", () => {
    const env = { OMB_BRAVE_SEARCH_API_KEY: "a", omb_brave_search_api_key: "b", OmB_BrAvE_SeArCh_ApI_KeY: "c", PATH: "keep" };
    stripWorkspaceCredentialEnv(env); expect(env).toEqual({ PATH: "keep" });
  });
});
