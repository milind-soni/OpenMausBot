import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { boxMemoryFrom, heapSizeArgs } from "./box-memory.ts";
import { serverCommand } from "./server-launcher.ts";

const GB = 1024 ** 3;

describe("the box's memory", () => {
  it("is the cgroup's limit only when one is set below the machine's memory", () => {
    expect(boxMemoryFrom(0, 16 * GB)).toEqual({ bytes: 16 * GB, cgroupLimit: null });
    expect(boxMemoryFrom(2 ** 64 - 1, 8 * GB)).toEqual({ bytes: 8 * GB, cgroupLimit: null });
    expect(boxMemoryFrom(GB, 8 * GB)).toEqual({ bytes: GB, cgroupLimit: GB });
  });

  it("sizes the heap to 60% of a cgroup limit, unless NODE_OPTIONS already does", () => {
    expect(heapSizeArgs(GB, undefined)).toEqual(["--max-old-space-size=614"]);
    expect(heapSizeArgs(128 * 1024 ** 2, "")).toEqual(["--max-old-space-size=128"]);
    expect(heapSizeArgs(64 * GB, "--enable-source-maps")).toEqual(["--max-old-space-size=4096"]);
    expect(heapSizeArgs(null, undefined)).toEqual([]);
    expect(heapSizeArgs(GB, "--max_old_space_size=300")).toEqual([]);
    expect(heapSizeArgs(GB, "--max-old-space-size=300")).toEqual([]);
  });
});

describe("the container's server command", () => {
  const here = join("/app", "dist-server");
  const small = { bytes: GB, cgroupLimit: GB };

  it("runs the server through the compile-cache bootstrap, its cache on the data volume, its heap sized to the limit", () => {
    const command = serverCommand(here, { OMB_DATA_DIR: join("/srv", "omb"), OMB_PORT: "8799" }, { exists: () => true, box: small });
    expect(command).toEqual({
      args: ["--max-old-space-size=614", join(here, "desktop-entry.mjs")],
      env: { OMB_DATA_DIR: join("/srv", "omb"), OMB_PORT: "8799", OMB_SERVER_COMPILE_CACHE: join("/srv", "omb", "cache", "node-compile") },
    });
    expect(serverCommand(here, {}, { exists: () => true, box: small }).env.OMB_SERVER_COMPILE_CACHE)
      .toBe(join(homedir(), ".openmausbot", "cache", "node-compile"));
  });

  it("runs index.js itself without the bootstrap, and leaves the heap alone without a limit or when NODE_OPTIONS sizes it", () => {
    expect(serverCommand(here, {}, { exists: () => false, box: { bytes: 16 * GB, cgroupLimit: null } })).toEqual({ args: [join(here, "index.js")], env: {} });
    expect(serverCommand(here, { NODE_OPTIONS: "--max-old-space-size=900" }, { exists: () => true, box: small }).args).toEqual([join(here, "desktop-entry.mjs")]);
  });
});
