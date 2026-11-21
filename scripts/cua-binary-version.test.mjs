import { describe, expect, it } from "vitest";
import { describeExitCode, describeRun, probeCuaVersion } from "./cua-binary-version.mjs";

const failure = (fields) => Object.assign(new Error("Command failed"), fields);

describe("a CUA Driver that gives no version is described as it failed", () => {
  it("names a Windows NTSTATUS exit in hex with what it means, and leaves an ordinary exit code as it is", () => {
    expect(describeExitCode(3221225781)).toBe("3221225781 (0xC0000135, STATUS_DLL_NOT_FOUND: a DLL it needs is missing)");
    expect(describeExitCode(-1073741515)).toContain("0xC0000135");
    expect(describeExitCode(3221225477)).toContain("0xC0000005, STATUS_ACCESS_VIOLATION");
    expect(describeExitCode(3221226505)).toContain("0xC0000409");
    expect(describeExitCode(2)).toBe("2");
  });

  it("tells a refused start, a timeout, a crash and a clean exit with other output apart, with what each printed", () => {
    expect(describeRun({ error: failure({ code: "EACCES", syscall: "spawn C:\\cua-driver.exe", errno: -4092 }), stdout: "", stderr: "", elapsedMs: 3 }, 20_000))
      .toBe('could not run: EACCES (spawn C:\\cua-driver.exe) errno -4092 after 3 ms; stdout ""; stderr ""');
    expect(describeRun({ error: failure({ killed: true, signal: "SIGTERM", code: null }), stdout: "", stderr: "", elapsedMs: 20_004 }, 20_000))
      .toMatch(/^timed out after 20000 ms and was ended with SIGTERM/);
    expect(describeRun({ error: failure({ code: 3221225781 }), stdout: "", stderr: "", elapsedMs: 40 }, 20_000))
      .toMatch(/^exited with code 3221225781 \(0xC0000135, STATUS_DLL_NOT_FOUND/);
    expect(describeRun({ error: failure({ code: 1 }), stdout: "", stderr: "panicked at src/main.rs", elapsedMs: 9 }, 20_000))
      .toBe('exited with code 1 after 9 ms; stdout ""; stderr "panicked at src/main.rs"');
    expect(describeRun({ error: null, stdout: "cua-driver-rs 0.45.4\n", stderr: "", elapsedMs: 7 }, 20_000))
      .toBe('exited with code 0 after 7 ms; stdout "cua-driver-rs 0.45.4"; stderr ""');
  });
});

describe("asking a CUA Driver for its version", () => {
  it("tries again after a short wait when the first start fails, and takes the version the next one reports", async () => {
    const results = [{ error: failure({ code: "EBUSY", syscall: "spawn" }), stdout: "", stderr: "", elapsedMs: 1 }, { error: null, stdout: "cua-driver 0.45.4\n", stderr: "", elapsedMs: 1 }];
    const waits = [];
    const probe = await probeCuaVersion(process.execPath, { run: async () => results.shift(), sleep: async (ms) => { waits.push(ms); } });
    expect(probe).toEqual({ version: "0.45.4", why: null });
    expect(waits).toEqual([2_000]);
  });

  it("says every attempt when none gives a version", async () => {
    let runs = 0;
    const probe = await probeCuaVersion(process.execPath, {
      attempts: 2, run: async () => { runs++; return { error: failure({ code: 3221225781 }), stdout: "", stderr: "", elapsedMs: 5 }; }, sleep: async () => {},
    });
    expect(runs).toBe(2);
    expect(probe.version).toBeNull();
    expect(probe.why).toMatch(/gave no version in 2 attempts: it \(1\) exited with code 3221225781 \(0xC0000135.*\(2\) exited with code 3221225781/);
  });

  it("says a missing executable is missing, without running anything", async () => {
    const probe = await probeCuaVersion("/nowhere/cua-driver", { run: async () => { throw new Error("ran"); } });
    expect(probe).toEqual({ version: null, why: "/nowhere/cua-driver does not exist" });
  });

  it("reports what a real executable printed when it is not a CUA Driver", async () => {
    const probe = await probeCuaVersion(process.execPath, { attempts: 1 });
    expect(probe.version).toBeNull();
    expect(probe.why).toContain(`exited with code 0`);
    expect(probe.why).toContain(`stdout ${JSON.stringify(process.version)}`);
  });
});
