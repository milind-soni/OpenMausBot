import { describe, expect, it } from "vitest";

import { sshConfigHosts, type SshConfigFiles } from "./ssh-config-hosts.ts";

function files(map: Record<string, string>): SshConfigFiles {
  return {
    read: (path) => map[path] ?? null,
    list: (directory) => Object.keys(map).filter((path) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/")).map((path) => path.slice(directory.length + 1)).sort(),
  };
}

describe("sshConfigHosts", () => {
  it("lists concrete Host names once, in order, and skips patterns and negations", () => {
    const hosts = sshConfigHosts("/h/.ssh", files({
      "/h/.ssh/config": "Host *\n  User me\nHost example-host home-lab # comment\n  HostName 10.0.0.2\nhost = Prod\nHost *.corp !skip web?\nHost example-host\n",
    }));
    expect(hosts).toEqual(["example-host", "home-lab", "Prod"]);
  });

  it("follows Include, relative to ~/.ssh and with a wildcard, and survives a loop", () => {
    const hosts = sshConfigHosts("/h/.ssh", files({
      "/h/.ssh/config": "Include config.d/*\nInclude config\nHost first\n",
      "/h/.ssh/config.d/a": "Host from-a\n",
      "/h/.ssh/config.d/b": "Host from-b\n",
    }));
    expect(hosts).toEqual(["from-a", "from-b", "first"]);
  });

  it("is empty with no config file, and drops names that are not simple aliases", () => {
    expect(sshConfigHosts("/h/.ssh", files({}))).toEqual([]);
    expect(sshConfigHosts("/h/.ssh", files({ "/h/.ssh/config": "Host bad;name ok-name user@host\n" }))).toEqual(["ok-name"]);
  });
});
