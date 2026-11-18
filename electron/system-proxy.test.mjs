// A Mac whose internet goes through a proxy set in System Settings: the server reaches HTTPS sites through it too.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { cidrAsRange, createSystemProxyCache, macProxyFromScutil, systemProxyEnvironment } from "./system-proxy.mjs";

const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 1082
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 1082
  HTTPSProxy : 127.0.0.1
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPSEnable : 1
      HTTPSPort : 9999
      HTTPSProxy : 10.0.0.9
    }
  }
}
`;

const read = (output) => async () => output;

describe("the Mac's system proxy", () => {
  it("reads the HTTPS proxy and its exceptions from the top level only", () => {
    expect(macProxyFromScutil(SCUTIL)).toEqual({ https: "http://127.0.0.1:1082", exceptions: ["*.local", "169.254/16"] });
  });

  it("finds none when the HTTPS proxy is off, half set or the output is empty", () => {
    expect(macProxyFromScutil(SCUTIL.replace("HTTPSEnable : 1\n  HTTPSPort", "HTTPSEnable : 0\n  HTTPSPort"))).toBeNull();
    expect(macProxyFromScutil("<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 8080\n}\n")).toBeNull();
    expect(macProxyFromScutil("")).toBeNull();
  });

  it("brackets an IPv6 proxy host", () => {
    expect(macProxyFromScutil("<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 8080\n  HTTPSProxy : ::1\n}\n")?.https).toBe("http://[::1]:8080");
  });

  it("gives the server the proxy, its exceptions and loopback on a Mac with none set in the environment", async () => {
    expect(await systemProxyEnvironment({ platform: "darwin", env: {}, read: read(SCUTIL) })).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:1082",
      https_proxy: "http://127.0.0.1:1082",
      NO_PROXY: "*.local,169.254.0.0-169.254.255.255,localhost,127.0.0.1,::1,[::1]",
      no_proxy: "*.local,169.254.0.0-169.254.255.255,localhost,127.0.0.1,::1,[::1]",
      NODE_USE_ENV_PROXY: "1",
    });
  });

  it("keeps the hosts a NO_PROXY in the environment already skips", async () => {
    const env = await systemProxyEnvironment({ platform: "darwin", env: { no_proxy: "intranet.example, localhost" }, read: read(SCUTIL) });
    expect(env.NO_PROXY).toBe("intranet.example,localhost,*.local,169.254.0.0-169.254.255.255,127.0.0.1,::1,[::1]");
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it("never touches a proxy already set in the environment, in any case", async () => {
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      expect(await systemProxyEnvironment({ platform: "darwin", env: { [name]: "http://corp:3128" }, read: read(SCUTIL) })).toEqual({});
    }
  });

  it("changes nothing off a Mac, without a system proxy or when scutil fails", async () => {
    expect(await systemProxyEnvironment({ platform: "win32", env: {}, read: read(SCUTIL) })).toEqual({});
    expect(await systemProxyEnvironment({ platform: "linux", env: {}, read: read(SCUTIL) })).toEqual({});
    expect(await systemProxyEnvironment({ platform: "darwin", env: {}, read: read("<dictionary> {\n  HTTPSEnable : 0\n}\n") })).toEqual({});
    expect(await systemProxyEnvironment({ platform: "darwin", env: {}, read: read("") })).toEqual({});
  });

  it("leaves everything alone when the environment's NO_PROXY already skips every host", async () => {
    expect(await systemProxyEnvironment({ platform: "darwin", env: { NO_PROXY: "*" }, read: read(SCUTIL) })).toEqual({});
    expect(await systemProxyEnvironment({ platform: "darwin", env: { no_proxy: "intranet.example, *" }, read: read(SCUTIL) })).toEqual({});
  });

  it("turns an IPv4 CIDR exception into the range Node's proxy matcher understands, and nothing else", () => {
    expect(cidrAsRange("169.254/16")).toBe("169.254.0.0-169.254.255.255");
    expect(cidrAsRange("10.0.0.0/8")).toBe("10.0.0.0-10.255.255.255");
    expect(cidrAsRange("192.168.1.7/32")).toBe("192.168.1.7-192.168.1.7");
    expect(cidrAsRange("172.16.5.9/12")).toBe("172.16.0.0-172.31.255.255");
    for (const entry of ["*.local", "example.com", "127.0.0.1", "300.1/16", "10.0.0.0/33", "::1/128"]) expect(cidrAsRange(entry)).toBe(entry);
  });
});

const [major, minor] = process.versions.node.split(".").map(Number);
/** Node reads NODE_USE_ENV_PROXY for https.request from 24.5 on. */
const envProxyWorks = major > 24 || (major === 24 && minor >= 5);

/** Starts a real child Node with the env this module gives it and asks whether an HTTPS request to host goes to the proxy. */
async function requestGoesThroughProxy(host) {
  let connections = 0;
  const proxy = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const scutil = `<dictionary> {\n  ExceptionsList : <array> {\n    0 : 169.254/16\n  }\n  HTTPSEnable : 1\n  HTTPSPort : ${proxy.address().port}\n  HTTPSProxy : 127.0.0.1\n}\n`;
    const added = await systemProxyEnvironment({ platform: "darwin", env: {}, read: read(scutil) });
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?|no|all)_proxy$/i.test(name)));
    const child = `setTimeout(() => process.exit(0), 3000);
      const req = require("node:https").request({ host: process.argv[1], port: 443, timeout: 400 });
      req.on("timeout", () => req.destroy()); req.on("error", () => {}); req.on("close", () => process.exit(0)); req.end();`;
    await new Promise((resolve) => execFile(process.execPath, ["-e", child, host], { env: { ...env, ...added } }, () => resolve()));
    return connections > 0;
  } finally {
    proxy.close();
  }
}

describe.runIf(envProxyWorks)("a server started with that env", () => {
  it("sends HTTPS through the proxy, but not to an address the CIDR exception covers", async () => {
    expect(await requestGoesThroughProxy("203.0.113.5")).toBe(true);
    expect(await requestGoesThroughProxy("169.254.1.2")).toBe(false);
  }, 15_000);
});

describe("main.mjs's use of the system proxy", () => {
  it("never awaits between the shutdown check and the fork, so a recovery restart and a switch cannot both fork", () => {
    const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const start = source.indexOf("async function startServerOn(");
    const launch = source.slice(start, source.indexOf("utilityProcess.fork(", start));
    expect(start).toBeGreaterThan(-1);
    expect(launch).toContain("if (desktopShutdownStarted)");
    expect(launch).not.toMatch(/\bawait\b/);
    expect(launch).toContain("...systemProxy.latest()");
  });

  it("keeps the last lookup until the next refresh, and starts empty", async () => {
    const results = [{ HTTPS_PROXY: "http://a:1" }, {}];
    const cache = createSystemProxyCache(async () => results.shift());
    expect(cache.latest()).toEqual({});
    await cache.refresh();
    expect(cache.latest()).toEqual({ HTTPS_PROXY: "http://a:1" });
    await cache.refresh();
    expect(cache.latest()).toEqual({});
  });

  it("keeps the newest refresh when an older lookup finishes after it", async () => {
    const pending = [];
    const cache = createSystemProxyCache(() => new Promise((resolve) => pending.push(resolve)));
    const older = cache.refresh();
    const newer = cache.refresh();
    pending[1]({ HTTPS_PROXY: "http://new:2" });
    await newer;
    pending[0]({});
    await older;
    expect(cache.latest()).toEqual({ HTTPS_PROXY: "http://new:2" });
  });
});
