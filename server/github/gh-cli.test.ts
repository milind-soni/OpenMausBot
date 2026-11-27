import { describe, expect, it } from "vitest";

import { ghCredentialTargets, loginArgs, ownGhEnv, windowsGhDirs } from "./gh-cli.ts";

describe("running GitHub CLI for OpenMausBot's own sign-in", () => {
  it("passes on no token, no D-Bus session and none of the server's HOME", () => {
    const env = ownGhEnv({ home: "/data/github/owner/home", config: "/data/github/owner/config" }, {
      PATH: "/usr/bin", HOME: "/data", GH_TOKEN: "x", GITHUB_TOKEN: "x", GH_ENTERPRISE_TOKEN: "x", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      HTTPS_PROXY: "http://proxy:3128", OMB_ANYTHING: "x",
    }, "linux");
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/data/github/owner/home", GH_CONFIG_DIR: "/data/github/owner/config", HTTPS_PROXY: "http://proxy:3128",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/data/github/owner/home/.run/no-bus", XDG_RUNTIME_DIR: "/data/github/owner/home/.run" });
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "OMB_ANYTHING"]) expect(env[name], name).toBeUndefined();
    expect(ownGhEnv({ home: "C:\\h", config: "C:\\c" }, { PATH: "C:\\Windows" }, "win32")).toMatchObject({ USERPROFILE: "C:\\h", APPDATA: "C:\\h\\AppData\\Roaming" });
  });

  it("asks for a non-expiring token only where gh takes the flag", () => {
    expect(loginArgs([2, 103, 3])).toContain("--expiring=false");
    expect(loginArgs([2, 102, 0])).not.toContain("--expiring=false");
    expect(loginArgs([2, 102, 0])).toEqual(expect.arrayContaining(["--insecure-storage", "--clipboard=false", "--web"]));
  });

  it("looks for gh where GitHub CLI's Windows installers put it", () => {
    const dirs = windowsGhDirs({ ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" }, "C:\\Users\\ada");
    expect(dirs.join("|")).toMatch(/Program Files.GitHub CLI/u);
    expect(dirs.join("|")).toMatch(/WinGet.Links/u);
    expect(dirs.join("|")).toMatch(/scoop.shims/u);
  });

  it("finds gh's entries in Credential Manager's list", () => {
    const listing = [
      "Currently stored credentials:", "",
      "    Target: LegacyGeneric:target=gh:github.com:octo-fixture", "    Type: Generic", "    User: octo-fixture", "",
      "    Target: LegacyGeneric:target=gh:github.com:", "    Type: Generic", "",
      "    Target: LegacyGeneric:target=gh:_refreshable:github.com:octo-fixture", "",
      "    Target: LegacyGeneric:target=git:https://github.com", "",
      "    Target: MicrosoftAccount:target=SSO_POP_Device", "",
    ].join("\r\n");
    expect(ghCredentialTargets(listing)).toEqual(["gh:github.com:octo-fixture", "gh:github.com:", "gh:_refreshable:github.com:octo-fixture"]);
    expect(ghCredentialTargets("Currently stored credentials:\r\n\r\n* NONE *\r\n")).toEqual([]);
  });
});
