import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { defaultDataDir, testRunSignal } from "./data-dir.ts";

const REAL = join("/fake-account", "person");
const ELSEWHERE = join("/fake-temp", "omb-test-home-1");
const resolved = (env: Record<string, string | undefined>, home: string) => defaultDataDir(env, () => home, () => REAL);

describe("the default data folder", () => {
  it("is .openmausbot under the home in a normal run, whatever the home is", () => {
    expect(resolved({}, REAL)).toBe(join(REAL, ".openmausbot"));
    expect(resolved({ NODE_ENV: "production" }, REAL)).toBe(join(REAL, ".openmausbot"));
    expect(resolved({ OMB_BENCH: "0" }, REAL)).toBe(join(REAL, ".openmausbot"));
  });

  it("never asks for the account's home in a normal run", () => {
    expect(defaultDataDir({}, () => REAL, () => { throw new Error("read the account's home"); })).toBe(join(REAL, ".openmausbot"));
  });

  it.each([{ VITEST: "true" }, { NODE_ENV: "test" }, { OMB_BENCH: "1" }])("refuses the real home's folder in a test or benchmark run: %o", (env) => {
    expect(() => resolved(env, REAL)).toThrow(/OMB_DATA_DIR is not set.*before the process starts/);
    expect(() => resolved(env, join(REAL, "."))).toThrow(/refusing to use the real data folder/);
  });

  it("names what marked the run", () => {
    expect(() => resolved({ OMB_BENCH: "1" }, REAL)).toThrow(/^OMB_BENCH=1 marks/);
    expect(testRunSignal({ NODE_ENV: "test" })).toBe("NODE_ENV=test");
    expect(testRunSignal({ NODE_ENV: "development", OMB_BENCH: "" })).toBeNull();
  });

  it("accepts a redirected home in a test run, and one inside the real home", () => {
    expect(resolved({ VITEST: "true" }, ELSEWHERE)).toBe(join(ELSEWHERE, ".openmausbot"));
    expect(resolved({ NODE_ENV: "test" }, join(REAL, "AppData", "Local", "Temp", "omb-test-home-1"))).toBe(join(REAL, "AppData", "Local", "Temp", "omb-test-home-1", ".openmausbot"));
  });

  it("takes OMB_DATA_DIR as given in every kind of run, and treats an empty one as unset", () => {
    expect(resolved({ OMB_BENCH: "1", OMB_DATA_DIR: join(REAL, "bench-data") }, REAL)).toBe(join(REAL, "bench-data"));
    expect(resolved({ OMB_DATA_DIR: "" }, ELSEWHERE)).toBe(join(ELSEWHERE, ".openmausbot"));
    expect(() => resolved({ OMB_BENCH: "1", OMB_DATA_DIR: "" }, REAL)).toThrow(/OMB_DATA_DIR is not set/);
  });

  it("does not refuse where the account has no home entry", () => {
    expect(defaultDataDir({ NODE_ENV: "test" }, () => REAL, () => null)).toBe(join(REAL, ".openmausbot"));
  });
});
