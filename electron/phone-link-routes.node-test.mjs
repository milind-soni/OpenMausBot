import assert from "node:assert/strict";
import test from "node:test";

import { createPhoneLinkRoutes, PHONE_LINK_SLEEP_GRACE_MS } from "./phone-link-routes.mjs";
import { checkTailscale, magicDnsName, readTailscaleStatus, TAILSCALE_CLI_PATHS, tailscaleEnvironment, tailscaleInstall } from "./tailscale-check.mjs";

function world({ check = async () => ({ state: "ready", name: "mac.tail1.ts.net" }), tailscaleOn = false, sidecar = null } = {}) {
  const w = { routes: { tailscale: tailscaleOn }, names: [], computers: [], shares: 0, checks: 0, wakes: 0, sleeps: 0, changed: [], clock: 1_000_000, sidecar, running: sidecar !== null };
  w.links = createPhoneLinkRoutes({
    rememberRoute: async (route, on, extra) => { w.routes[route] = on; if (extra?.name) w.names.push(extra.name); if (extra?.computers !== undefined) w.computers.push(extra.computers); },
    shareChanged: async () => { w.shares++; },
    routeOn: (route) => w.routes[route] === true,
    dismissNotice: () => {},
    state: async () => ({ routes: w.routes, ...(w.sidecar ?? { enabled: false }) }),
    running: () => w.running,
    wake: async () => { w.wakes++; },
    sleep: async () => { w.sleeps++; w.running = false; },
    changed: async (route, on) => { w.changed.push([route, on]); },
    check: async () => { w.checks++; return check(); },
    now: () => w.clock,
    setTimer: () => ({ unref() {} }),
  });
  return w;
}

test("Tailscale's Turn on asks Tailscale once, keeps the name, and wakes a link with something paired", async () => {
  const w = world();
  await w.links.setTailscale(true);
  assert.equal(w.checks, 1);
  assert.equal(w.routes.tailscale, true);
  assert.deepEqual(w.names, ["mac.tail1.ts.net"]);
  assert.equal(w.wakes, 1);
});

test("a Tailscale that isn't installed or is signed out leaves the route off and says why", async () => {
  for (const state of ["not-installed", "signed-out"]) {
    const w = world({ check: async () => ({ state }) });
    const reply = await w.links.setTailscale(true);
    assert.equal(reply.tailscaleProblem, state);
    assert.equal(w.routes.tailscale, false);
    assert.equal(w.wakes, 0);
  }
});

test("Check again runs Tailscale only while its route is on, and starts nothing", async () => {
  const off = world();
  await off.links.checkTailscale();
  assert.equal(off.checks, 0, "off: nothing is run");
  const on = world({ tailscaleOn: true });
  await on.links.checkTailscale();
  assert.equal(on.checks, 1);
  assert.equal(on.wakes, 0, "Check again has no side effects");
});

test("turning Tailscale off runs nothing", async () => {
  const w = world({ tailscaleOn: true });
  await w.links.setTailscale(false);
  assert.equal(w.checks, 0);
  assert.equal(w.routes.tailscale, false);
});

test("the switch for other computers needs the Tailscale route, and every Tailscale change reaches the share", async () => {
  const off = world();
  await off.links.setTailscaleComputers(true);
  assert.deepEqual([off.computers, off.shares, off.routes.tailscale], [[], 0, false], "no route, no share");
  const on = world({ tailscaleOn: true });
  await on.links.setTailscaleComputers(true);
  assert.deepEqual([on.computers, on.shares], [[true], 1]);
  await on.links.checkTailscale();
  assert.equal(on.shares, 2);
  await on.links.setTailscale(false);
  assert.equal(on.shares, 3);
});

test("other routes switch on their own, tell main which changed, and wake only when turned on", async () => {
  const w = world();
  await w.links.setRoute("relay", true);
  await w.links.setRoute("https", false);
  await w.links.setRoute("nonsense", true);
  assert.deepEqual(w.changed, [["relay", true], ["https", false]]);
  assert.equal(w.wakes, 1);
  assert.equal(w.routes.nonsense, undefined);
});

test("an empty sidecar goes back to sleep after the grace for a code, never one with a device or a code open", async () => {
  const empty = world({ sidecar: { enabled: true, devices: [], pairing: null } });
  empty.links.touched();
  assert.equal(await empty.links.sleepIfIdle(), false, "just started for a code");
  empty.clock += PHONE_LINK_SLEEP_GRACE_MS;
  assert.equal(await empty.links.sleepIfIdle(), true);
  assert.equal(empty.sleeps, 1);

  const paired = world({ sidecar: { enabled: true, devices: [{ id: "a" }], pairing: null } });
  paired.clock += PHONE_LINK_SLEEP_GRACE_MS;
  assert.equal(await paired.links.sleepIfIdle(), false);
  const pairing = world({ sidecar: { enabled: true, devices: [], pairing: { code: "1" } } });
  pairing.clock += PHONE_LINK_SLEEP_GRACE_MS;
  assert.equal(await pairing.links.sleepIfIdle(), false);
});

test("Tailscale presence is checked by looking for files; nothing runs when none is there", async () => {
  const none = { exists: () => false, env: { PATH: "" }, home: "/nowhere", platform: "darwin" };
  assert.equal(tailscaleInstall(none), "none");
  assert.equal(tailscaleInstall({ ...none, exists: (file) => file === "/usr/bin/tailscale" }), "cli");
  assert.equal(tailscaleInstall({ ...none, exists: (file) => file === "/Applications/Tailscale.app" }), "app-only");
  let runs = 0;
  const run = async () => { runs++; return { missing: false, stdout: "", stderr: "" }; };
  assert.deepEqual(await checkTailscale({ install: () => "none", run }), { state: "not-installed" });
  const onTailnet = () => ({ utun4: [{ address: "100.101.102.103" }, { address: "fd7a:115c:a1e0::1" }] });
  assert.deepEqual(await checkTailscale({ install: () => "app-only", run, interfaces: onTailnet, reverse: async () => null }), { state: "no-cli" }, "the macOS app's executable is never run");
  assert.deepEqual(await checkTailscale({ install: () => "app-only", run, interfaces: () => ({}), reverse: async () => null }), { state: "not-running" });
  assert.equal(runs, 0);
});

test("a Mac with only the Tailscale app learns its name from MagicDNS, still running nothing", async () => {
  let runs = 0, asked = null;
  const result = await checkTailscale({
    install: () => "app-only",
    run: async () => { runs++; return { missing: false, stdout: "", stderr: "" }; },
    interfaces: () => ({ utun4: [{ address: "fd7a:115c:a1e0::1" }, { address: "100.101.102.103" }] }),
    reverse: async (address) => { asked = address; return "mac.tail1.ts.net"; },
  });
  assert.deepEqual(result, { state: "ready", name: "mac.tail1.ts.net", addresses: ["100.101.102.103", "fd7a:115c:a1e0::1"], https: false, cli: null });
  assert.equal(asked, "100.101.102.103");
  assert.equal(runs, 0);
  const servers = [];
  const resolver = (names) => ({ setServers: (list) => servers.push(...list), reverse: async () => { if (names instanceof Error) throw names; return names; } });
  assert.equal(await magicDnsName("100.101.102.103", { resolver: resolver(["Mac.tail1.ts.net."]) }), "mac.tail1.ts.net");
  assert.deepEqual(servers, ["100.100.100.100"]);
  assert.equal(await magicDnsName("100.101.102.103", { resolver: resolver(["mac.example.com."]) }), null);
  assert.equal(await magicDnsName("100.101.102.103", { resolver: resolver(new Error("ETIMEOUT")) }), null);
  assert.equal(await magicDnsName(undefined, { resolver: resolver([]) }), null);
});

test("one status reading tells ready, signed out, not running and not allowed apart", async () => {
  assert.deepEqual(readTailscaleStatus(JSON.stringify({ BackendState: "Running", CertDomains: ["mac.tail1.ts.net"], Self: { DNSName: "Mac.tail1.ts.net.", TailscaleIPs: ["100.64.0.2"] } })), { state: "ready", name: "mac.tail1.ts.net", addresses: ["100.64.0.2"], https: true });
  assert.deepEqual(readTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "" } })), { state: "signed-out" });
  assert.deepEqual(readTailscaleStatus(JSON.stringify({ BackendState: "Stopped" })), { state: "not-running" });
  assert.deepEqual(readTailscaleStatus("", "failed to connect to local tailscaled; it doesn't appear to be running"), { state: "not-running" });
  assert.deepEqual(readTailscaleStatus("", "Access denied: watch IPN bus access denied"), { state: "needs-permission" });
  const tried = [];
  const result = await checkTailscale({
    install: () => "cli",
    candidates: ["/opt/homebrew/bin/tailscale", "/usr/bin/tailscale"],
    run: async (cli) => { tried.push(cli); return cli === "/opt/homebrew/bin/tailscale" ? { missing: true, stdout: "", stderr: "" } : { missing: false, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail1.ts.net." } }), stderr: "" }; },
  });
  assert.deepEqual(result, { state: "ready", name: "mac.tail1.ts.net", addresses: [], https: false, cli: "/usr/bin/tailscale" });
  assert.deepEqual(tried, ["/opt/homebrew/bin/tailscale", "/usr/bin/tailscale"]);
  assert.ok(!TAILSCALE_CLI_PATHS.some((cli) => /Tailscale\.app/.test(cli)), "no app executable among the candidates");
  assert.equal(tailscaleEnvironment({ PATH: "" }).TAILSCALE_BE_CLI, "1");
});
