import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import viteConfig from "../../vite.config.ts";
import { E2E, HOST_E2E, hostE2eOnly, isPortableE2e, portableE2eFiles } from "./host-e2e.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const INCLUDE = viteConfig.test?.include ?? [];
// A test, or a whole describe, that Linux skips: what it checks runs on the Windows and macOS shards or nowhere.
const SKIPPED_ON_LINUX = /process\.platform\s*===\s*"linux"\s*\?\s*(?:it|test|describe)\.skip\b|\.skipIf\(\s*process\.platform\s*===\s*"linux"\s*\)|\.runIf\(\s*process\.platform\s*===\s*"(?:darwin|win32)"\s*\)/;

describe("the e2e files every host runs", () => {
  it("are e2e files that exist", () => {
    for (const file of Object.keys(HOST_E2E)) {
      expect(E2E.test(file), file).toBe(true);
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });

  it("include every e2e file with a test that Linux skips", () => {
    const missing = portableE2eFiles(ROOT, INCLUDE).filter((file) => SKIPPED_ON_LINUX.test(readFileSync(path.join(ROOT, file), "utf8")));
    expect(missing, "add these to HOST_E2E in scripts/testing/host-e2e.ts, with what they check that Linux cannot").toEqual([]);
  });

  it("recognises the ways a test is skipped on Linux", () => {
    for (const source of [
      `const itHost = process.platform === "linux" ? it.skip : it;`,
      `it.skipIf(process.platform === "linux")("mounts", () => {});`,
      `it.runIf(process.platform === "darwin")("speaks", () => {});`,
      `describe.runIf(process.platform === "win32")("PowerShell", () => {});`,
    ]) expect(SKIPPED_ON_LINUX.test(source), source).toBe(true);
    expect(SKIPPED_ON_LINUX.test(`it.skipIf(process.platform === "win32")("POSIX only", () => {});`)).toBe(false);
  });

  it("leave every other test file to every host", () => {
    expect(isPortableE2e("server/room-coordination.e2e.test.ts")).toBe(true);
    expect(isPortableE2e("server/shared-computers.e2e.test.ts")).toBe(false);
    expect(isPortableE2e("server/steer-queue.test.ts")).toBe(false);
    const portable = portableE2eFiles(ROOT, INCLUDE);
    expect(portable.length).toBeGreaterThan(100);
    expect(portable.every((file) => E2E.test(file) && !Object.hasOwn(HOST_E2E, file))).toBe(true);
  });

  it("apply only when CI asks for them", () => {
    expect(hostE2eOnly({ OMB_VITEST_E2E: "host" })).toBe(true);
    expect(hostE2eOnly({ OMB_VITEST_E2E: "all" })).toBe(false);
    expect(hostE2eOnly({})).toBe(false);
  });
});
