import { describe, expect, it } from "vitest";
import { containerInit, IMAGE_INIT } from "./container-init.ts";

describe("the server as a container's process 1", () => {
  it("changes nothing behind an init, and nothing outside Linux", () => {
    expect(containerInit({ pid: 7, platform: "linux", exists: () => true })).toEqual({ prefix: [], line: null });
    for (const platform of ["darwin", "win32"] as const) expect(containerInit({ pid: 1, platform, exists: () => true })).toEqual({ prefix: [], line: null });
  });

  it("runs the server under the image's tini as a subreaper, and says so in one line", () => {
    const init = containerInit({ pid: 1, platform: "linux", exists: (path) => path === IMAGE_INIT });
    expect(init.prefix).toEqual(["/usr/bin/tini", "-s", "--"]);
    expect(init.line).toContain("process 1");
    expect(init.line).toContain("docs/self-hosting.md");
    expect(init.line).not.toContain("\n");
  });

  it("without tini only says what will happen and how to fix it", () => {
    const init = containerInit({ pid: 1, platform: "linux", exists: () => false });
    expect(init.prefix).toEqual([]);
    expect(init.line).toContain("spawn EAGAIN");
    expect(init.line).toContain("--init");
    expect(init.line).not.toContain("\n");
  });
});
