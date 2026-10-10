import { describe, expect, it } from "vitest";

import { retryOnWindowsFileLock, transientWindowsFileError } from "./antigravity-runtime.ts";

const withCode = (code: string) => Object.assign(new Error(code), { code });

describe("installing the Antigravity runtime on Windows", () => {
  it("knows the refusals Windows gives for a file something still holds open", () => {
    for (const code of ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]) expect(transientWindowsFileError(withCode(code)), code).toBe(true);
    expect(transientWindowsFileError(withCode("ENOENT"))).toBe(false);
    expect(transientWindowsFileError(new Error("plain"))).toBe(false);
    expect(transientWindowsFileError(null)).toBe(false);
  });

  it("retries a rename that Windows refuses while the runtime is still exiting, with growing delays", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await retryOnWindowsFileLock(
      async () => {
        calls += 1;
        if (calls < 3) throw withCode("EPERM");
        return "renamed";
      },
      { sleep: async (ms) => { delays.push(ms); } },
    );
    expect(result).toBe("renamed");
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it("gives up after the attempts with the original error, and never retries other errors", async () => {
    let calls = 0;
    await expect(retryOnWindowsFileLock(async () => {
      calls += 1;
      throw withCode("EBUSY");
    }, { attempts: 4, sleep: async () => {} })).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(4);

    calls = 0;
    await expect(retryOnWindowsFileLock(async () => {
      calls += 1;
      throw withCode("ENOENT");
    }, { sleep: async () => {} })).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("caps the delay at two seconds so a long lock does not turn into a long wait per attempt", async () => {
    const delays: number[] = [];
    await expect(retryOnWindowsFileLock(async () => {
      throw withCode("EPERM");
    }, { attempts: 8, sleep: async (ms) => { delays.push(ms); } })).rejects.toMatchObject({ code: "EPERM" });
    expect(delays).toEqual([250, 500, 1000, 2000, 2000, 2000, 2000]);
  });

});
