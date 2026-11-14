import { describe, expect, it } from "vitest";

import { splitCliString } from "../env-path.ts";
import { codexCliOverrides, codexLaunch } from "./codex-process.ts";

describe("empty launcher arguments with Codex overrides", () => {
  it.each(['""', "''"])("retains an explicit %s before a following argument", (empty) => {
    const launch = codexCliOverrides(`wrapper --label ${empty} next codex -c a=1`);
    expect(splitCliString(launch.cli)).toEqual(["wrapper", "--label", "", "next", "codex"]);
    expect(launch.overrides).toEqual(["-c", "a=1"]);
  });

  it("retains multiple empty arguments at the end of the rewritten launcher", () => {
    const [cli, args] = codexLaunch('wrapper codex --config=a=1 "" \'\'', ["app-server", "--stdio"]);
    expect(splitCliString(cli)).toEqual(["wrapper", "codex", "", ""]);
    expect(args).toEqual(["app-server", "-c", "a=1", "--stdio"]);
  });
});
