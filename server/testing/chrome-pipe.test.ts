import { userInfo } from "node:os";
import { describe, expect, it } from "vitest";

import { chromeLaunchArgs, chromeLaunchEnv } from "./chrome-pipe.ts";

describe("the test Chrome launcher", () => {
  it("keeps Chrome off the person's keychain on macOS and keyring on Linux", () => {
    expect(chromeLaunchArgs("/profile", [], "darwin")).toContain("--use-mock-keychain");
    expect(chromeLaunchArgs("/profile", [], "darwin")).not.toContain("--password-store=basic");
    expect(chromeLaunchArgs("/profile", [], "linux")).toContain("--password-store=basic");
    expect(chromeLaunchArgs("/profile", [], "win32").filter((arg) => /keychain|password-store/.test(arg))).toEqual([]);
    expect(chromeLaunchArgs("/profile", ["--proxy-server=socks5://127.0.0.1:1"], process.platform)).toEqual(expect.arrayContaining(["--remote-debugging-pipe", "--user-data-dir=/profile", "--proxy-server=socks5://127.0.0.1:1"]));
  });

  it("gives Chrome the account's real home, never the test runner's throwaway one", () => {
    expect(process.env.HOME).not.toBe(userInfo().homedir);
    expect(chromeLaunchEnv({ HOME: "/tmp/fake-home", PATH: "/bin" }, "darwin")).toEqual({ HOME: userInfo().homedir, PATH: "/bin" });
    expect(chromeLaunchEnv({ USERPROFILE: "C:\\fake" }, "win32").USERPROFILE).toBe(userInfo().homedir);
  });
});
