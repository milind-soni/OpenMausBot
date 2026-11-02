import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystemProxyResolver } from "./system-proxy-resolver.mjs";

function fixture() {
  let settings = { autoDetect: false, pacUrl: "http://fixture.invalid/proxy.pac", discoveredPacUrl: null, proxy: "proxy.invalid:8080", bypass: "<local>" };
  const configs = [];
  const resolver = createSystemProxyResolver({ platform: "win32", session: {
    setProxy: async config => configs.push(config), forceReloadProxyConfig: async () => {}, resolveProxy: async () => "DIRECT",
  }, readWindows: async () => { if (settings instanceof Error) throw settings; return settings; } });
  return { resolver, configs, set: value => { settings = value; } };
}

test("Windows PAC takes precedence over manual fallback and is installed in mandatory mode", async () => {
  const { resolver, configs } = fixture();
  await resolver.forceReloadProxyConfig();
  assert.deepEqual(configs, [{ mode: "pac_script", pacScript: "http://fixture.invalid/proxy.pac" }]);
  await resolver.forceReloadProxyConfig();
  assert.equal(configs.length, 1);
});

test("settings errors never select direct and explicit proxy off does select direct", async () => {
  const { resolver, configs, set } = fixture();
  await resolver.forceReloadProxyConfig();
  set(new Error("read failed"));
  await assert.rejects(resolver.forceReloadProxyConfig());
  assert.equal(configs.length, 1);
  set({ autoDetect: false, pacUrl: null, discoveredPacUrl: null, proxy: null, bypass: null });
  await resolver.forceReloadProxyConfig();
  assert.deepEqual(configs[1], { mode: "direct" });
});

test("WPAD disappearing after discovery fails closed until auto detection is disabled", async () => {
  const { resolver, configs, set } = fixture();
  set({ autoDetect: true, discoveredPacUrl: "http://wpad.fixture/proxy.pac" });
  await resolver.forceReloadProxyConfig();
  set({ autoDetect: true, discoveredPacUrl: null });
  await assert.rejects(resolver.forceReloadProxyConfig());
  assert.equal(configs.length, 1);
  set({ autoDetect: false });
  await resolver.forceReloadProxyConfig();
  assert.deepEqual(configs[1], { mode: "direct" });
});

test("manual proxies retain bypass rules and other platforms retain system mode", async () => {
  const { resolver, configs, set } = fixture();
  set({ autoDetect: false, proxy: "http=proxy.invalid:8080", bypass: "<local>;*.corp" });
  await resolver.forceReloadProxyConfig();
  assert.deepEqual(configs[0], { mode: "fixed_servers", proxyRules: "http=proxy.invalid:8080", proxyBypassRules: "<local>;*.corp" });
  const other = createSystemProxyResolver({ platform: "darwin", readWindows: async () => { throw new Error(); }, session: {
    setProxy: async config => configs.push(config), forceReloadProxyConfig: async () => {}, resolveProxy: async () => "DIRECT",
  } });
  await other.forceReloadProxyConfig();
  assert.deepEqual(configs[1], { mode: "system" });
});
