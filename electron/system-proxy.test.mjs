// A Mac whose internet goes through a proxy set in System Settings: the server reaches HTTPS sites through it too.
import { describe, expect, it } from "vitest";
import { macProxyFromScutil, systemProxyEnvironment } from "./system-proxy.mjs";

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
      NO_PROXY: "*.local,169.254/16,localhost,127.0.0.1,::1,[::1]",
      no_proxy: "*.local,169.254/16,localhost,127.0.0.1,::1,[::1]",
      NODE_USE_ENV_PROXY: "1",
    });
  });

  it("keeps the hosts a NO_PROXY in the environment already skips", async () => {
    const env = await systemProxyEnvironment({ platform: "darwin", env: { no_proxy: "intranet.example, localhost" }, read: read(SCUTIL) });
    expect(env.NO_PROXY).toBe("intranet.example,localhost,*.local,169.254/16,127.0.0.1,::1,[::1]");
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
});
