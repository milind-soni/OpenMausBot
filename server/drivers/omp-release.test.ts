import { describe, expect, it, vi } from "vitest";
import { createOmpReleaseReader, ompVersionBehind, parseOmpVersion } from "./omp-release.ts";

describe("omp version parsing", () => {
  it.each([
    { input: "18.5.0", version: "18.5.0", parts: [18, 5, 0], prerelease: false },
    { input: "v18.5.0", version: "18.5.0", parts: [18, 5, 0], prerelease: false },
    { input: "omp/19.0.0 (fake)", version: "19.0.0", parts: [19, 0, 0], prerelease: false },
    { input: "omp v18.4.12 (release)\nadditional CLI output", version: "18.4.12", parts: [18, 4, 12], prerelease: false },
    { input: " omp/18.5.0-canary.3+build.7 (fake)\n", version: "18.5.0-canary.3+build.7", parts: [18, 5, 0], prerelease: true },
    { input: "18.5.0-0", version: "18.5.0-0", parts: [18, 5, 0], prerelease: true },
    { input: "18.5.0+007.sha-a", version: "18.5.0+007.sha-a", parts: [18, 5, 0], prerelease: false },
  ])("parses $input", ({ input, version, parts, prerelease }) => {
    expect(parseOmpVersion(input)).toEqual({ version, parts, prerelease });
  });

  it.each([
    "omp dev build",
    "unrelated/18.5.0",
    "18.5.0 trailing text",
    "omp/18.5.0.1 (fake)",
    "01.5.0",
    "18.05.0",
    "18.5.00",
    "18.5.0-canary..3",
    "omp/18.5.0-canary.03 (fake)",
    "18.5.0+build..7",
    "18.5.0+build_7",
    "9007199254740992.5.0",
  ])("rejects malformed versions: %s", (input) => {
    expect(parseOmpVersion(input)).toBeNull();
  });
});

describe("omp stable releases", () => {
  it("compares omp's version output without mistaking newer or unreadable builds for old ones", () => {
    for (const installed of ["omp/18.4.12", "omp v18.4.12", "omp/18.4.12 (fake)", "18.5.0-canary.3", "omp/18.5.0-canary.3+build.7 (fake)", "omp/17.9.9"]) {
      expect(ompVersionBehind(installed, "18.5.0")).toBe(true);
    }
    for (const installed of ["omp/18.5.0", "omp/18.5.0+build.7", "omp/18.5.0+build.7 (fake)", "omp/18.5.1-canary.1", "omp/19.0.0", "omp/19.0.0 (fake)", "omp dev build"]) {
      expect(ompVersionBehind(installed, "18.5.0")).toBe(false);
    }
    expect(ompVersionBehind("omp/18.4.12", "18.6.0-canary.1")).toBe(false);
  });

  it.each(["18.5.0", "18.5.0+build.7", "18.5.0+001.sha"])("accepts stable semver metadata: %s", async (version) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ version })));
    expect(await createOmpReleaseReader(fetcher)()).toBe(version);
  });

  it("shares concurrent checks and refreshes after an hour", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ version: "18.5.0" })));
    const read = createOmpReleaseReader(fetcher, () => now);
    expect(await Promise.all([read(), read()])).toEqual(["18.5.0", "18.5.0"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 3_600_001;
    fetcher.mockResolvedValue(new Response(JSON.stringify({ version: "18.6.0" })));
    expect(await read()).toBe("18.6.0");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails quietly offline and retries after five minutes", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const read = createOmpReleaseReader(fetcher, () => now);
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 300_001;
    fetcher.mockResolvedValue(new Response(JSON.stringify({ version: "18.5.0" })));
    expect(await read()).toBe("18.5.0");
  });

  it.each([
    null,
    [],
    {},
    { version: 18 },
    { version: "latest" },
    { version: "18.6.0-canary.1" },
    { version: "18.6.0-canary.1+build.7" },
    { version: "18.6.0 trailing text" },
    { version: "omp/18.6.0 (fake)" },
    { version: "omp v18.6.0" },
    { version: "v18.6.0" },
    { version: " 18.6.0 " },
    { version: "18.6.0.1" },
    { version: "018.6.0" },
    { version: "18.6.0+build..7" },
  ])("ignores malformed or prerelease stable metadata: %j", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    expect(await createOmpReleaseReader(fetcher)()).toBeNull();
  });
});
