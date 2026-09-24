import { describe, expect, it, vi } from "vitest";
import { codexVersionBehind, createCodexReleaseReader } from "./codex-release.ts";

describe("Codex stable releases", () => {
  it("compares releases without mistaking newer nightlies or unknown wrappers for old builds", () => {
    for (const version of ["codex-cli 0.154.0", "0.155.0-alpha.16", "0.156.1-beta.1"]) {
      expect(codexVersionBehind(version, "0.156.1")).toBe(true);
    }
    for (const version of ["0.156.1", "0.156.1+build.1", "0.157.0-alpha.1", "1.0.0", "custom nightly", "0.154.0.4"]) {
      expect(codexVersionBehind(version, "0.156.1")).toBe(false);
    }
    expect(codexVersionBehind("0.154.0", "0.157.0-alpha.1")).toBe(false);
  });

  it("shares concurrent checks and refreshes after an hour", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ version: "0.156.1" })));
    const read = createCodexReleaseReader(fetcher, () => now);
    expect(await Promise.all([read(), read()])).toEqual(["0.156.1", "0.156.1"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 3_600_001;
    fetcher.mockResolvedValue(new Response(JSON.stringify({ version: "0.157.0" })));
    expect(await read()).toBe("0.157.0");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails quietly offline and retries after five minutes", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const read = createCodexReleaseReader(fetcher, () => now);
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 300_001;
    fetcher.mockResolvedValue(new Response(JSON.stringify({ version: "0.156.1" })));
    expect(await read()).toBe("0.156.1");
  });

  it.each([{}, { version: "nightly" }, { version: "0.157.0-alpha.1" }])("ignores malformed or prerelease stable metadata: %j", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    expect(await createCodexReleaseReader(fetcher)()).toBeNull();
  });
});
