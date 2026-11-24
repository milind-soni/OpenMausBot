import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { personalGhHostsFile, personalGhLogin } from "./personal-hosts.ts";

describe("the person's own gh hosts file", () => {
  it("is where gh keeps it on each platform", () => {
    expect(personalGhHostsFile({ GH_CONFIG_DIR: "/cfg", XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" }, "linux")).toBe(join("/cfg", "hosts.yml"));
    expect(personalGhHostsFile({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" }, "linux")).toBe(join("/xdg", "gh", "hosts.yml"));
    expect(personalGhHostsFile({ HOME: "/Users/me" }, "darwin")).toBe(join("/Users/me", ".config", "gh", "hosts.yml"));
    expect(personalGhHostsFile({ AppData: "C:\\Users\\me\\AppData\\Roaming", HOME: "C:\\Users\\me" }, "win32")).toBe(join("C:\\Users\\me\\AppData\\Roaming", "GitHub CLI", "hosts.yml"));
  });

  it("names a login only when it lists a github.com account", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-gh-hosts-"));
    try {
      expect(personalGhLogin({ GH_CONFIG_DIR: dir })).toBeNull();
      writeFileSync(join(dir, "hosts.yml"), "ghe.example.com:\n    user: corp\n");
      expect(personalGhLogin({ GH_CONFIG_DIR: dir })).toBeNull();
      writeFileSync(join(dir, "hosts.yml"), "github.com:\n    git_protocol: https\n    user: octo\n");
      expect(personalGhLogin({ GH_CONFIG_DIR: dir })).toBe("octo");
      mkdirSync(join(dir, "folder.yml"));
      expect(personalGhLogin({ GH_CONFIG_DIR: join(dir, "folder.yml") })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
