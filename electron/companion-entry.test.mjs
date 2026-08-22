// The packaged/built/source ladder for the sidecar's entry point. The case
// that used to be missing is the third rung: a dev checkout where nobody has
// run `pnpm build:companion`, which is most dev checkouts.
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveCompanionEntry } from "./companion-entry.mjs";

const RESOURCES = path.join("/tmp", "resources");
const APP = path.join("/tmp", "app");
const PACKAGED = path.join(RESOURCES, "companion", "index.js");
const BUILT = path.join(APP, "dist-companion", "index.js");
const SOURCE = path.join(APP, "companion", "src", "index.ts");

const resolve = (isPackaged, present) =>
  resolveCompanionEntry({
    isPackaged,
    resourcesPath: RESOURCES,
    appPath: APP,
    exists: (candidate) => present.includes(candidate),
  });

describe("companion entry resolution", () => {
  it("packaged: only the staged resource counts", () => {
    expect(resolve(true, [PACKAGED, BUILT, SOURCE])).toEqual({ entry: PACKAGED, execArgv: [] });
    // sources exist on a dev machine running a packaged build; they are not runnable resources
    expect(resolve(true, [BUILT, SOURCE])).toBeNull();
  });

  it("dev: prefers the compiled output when someone has built it", () => {
    expect(resolve(false, [BUILT, SOURCE])).toEqual({ entry: BUILT, execArgv: [] });
  });

  it("dev: falls back to the TypeScript source, with type stripping", () => {
    expect(resolve(false, [SOURCE])).toEqual({
      entry: SOURCE,
      execArgv: ["--experimental-strip-types"],
    });
  });

  it("dev: a checkout with neither is a null, not a spawn error", () => {
    expect(resolve(false, [])).toBeNull();
  });
});
