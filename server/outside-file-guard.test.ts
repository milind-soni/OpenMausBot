import { describe, expect, it } from "vitest";

import { outsideFileRefused, type OutsideFilePlace } from "./outside-file-guard.ts";

const mac: OutsideFilePlace = { home: "/Users/ada", platform: "darwin", env: {} };
const linux: OutsideFilePlace = { home: "/home/ada", platform: "linux", env: {} };
const windows: OutsideFilePlace = {
  home: "C:\\Users\\Ada", platform: "win32",
  env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
};

describe("files a self-hosted owner may open from outside the workspace", () => {
  it("allows an ordinary document", () => {
    expect(outsideFileRefused("/Users/ada/Documents/plan.md", mac)).toBe(false);
    expect(outsideFileRefused("/home/ada/projects/site/README.md", linux)).toBe(false);
    expect(outsideFileRefused("C:\\Users\\Ada\\Documents\\report.pdf", windows)).toBe(false);
  });

  it.each([
    "/home/ada/.ssh/config", "/home/ada/.aws/credentials", "/home/ada/.gnupg/pubring.kbx", "/home/ada/.config/gh/hosts.yml",
    "/home/ada/.claude/settings.json", "/home/ada/.codex/auth.json", "/home/ada/.pi/agent/auth.json",
    "/home/ada/.openmausbot-profiles/default/config.json", "/home/ada/.openmausbot/config.json", "/home/ada/.npmrc",
    "/home/ada/projects/site/.env", "/srv/app/.git/config",
  ])("refuses a hidden file or a file in a hidden folder: %s", (path) => {
    expect(outsideFileRefused(path, linux)).toBe(true);
  });

  it.each([
    "id_rsa", "id_rsa.pub", "id_ed25519", "id_ecdsa_work", "server.pem", "tls.KEY", "cert.p12", "cert.pfx", "vault.kdbx",
    "credentials", "credentials.json", "production.env",
  ])("refuses a name that looks like a key or credential: %s", (name) => {
    expect(outsideFileRefused(`/home/ada/Downloads/${name}`, linux)).toBe(true);
  });

  it.each([
    "/Users/ada/Library/Keychains/login.keychain-db", "/Library/Keychains/System.keychain", "/Users/ada/Library/Cookies/Cookies.binarycookies",
    "/Users/ada/Library/Application Support/Google/Chrome/Default/Login Data",
    "/Users/ada/Library/Application Support/Firefox/Profiles/x/logins.json", "/users/ADA/library/keychains/login.keychain-db",
  ])("refuses a macOS secret store: %s", (path) => {
    expect(outsideFileRefused(path, mac)).toBe(true);
  });

  it.each([
    "C:\\Users\\Ada\\AppData\\Roaming\\Microsoft\\Credentials\\ABC", "C:\\Users\\Ada\\AppData\\Roaming\\Microsoft\\Protect\\S-1\\x",
    "C:\\Users\\Ada\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data",
    "C:\\Users\\Ada\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cookies",
    "c:\\users\\ada\\appdata\\roaming\\microsoft\\credentials\\abc",
  ])("refuses a Windows secret store: %s", (path) => {
    expect(outsideFileRefused(path, windows)).toBe(true);
  });

  it("does not refuse another folder that merely shares a store's prefix", () => {
    expect(outsideFileRefused("/Users/ada/Library/KeychainsNotes/plan.md", mac)).toBe(false);
    expect(outsideFileRefused("/Users/ada/Library/Application Support/Notes/plan.md", mac)).toBe(false);
  });
});
