import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as procs from "../../procs.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { KimiAgentDriver } from "./kimi.ts";

afterEach(() => vi.restoreAllMocks());

it.each([
  [{ code: "ENOENT" }, "isn't installed, or isn't on this app's PATH"],
  [{ code: "EACCES" }, "isn't executable"],
  [{ killed: true, signal: "SIGTERM" }, "timed out"],
  [{ code: 1 }, "version check failed"],
  [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, "version check failed"],
  [null, "returned no version"],
])("does not call every failed version probe a missing CLI: %j", async (failure, reason) => {
  vi.spyOn(procs, "execCli").mockImplementation((_cli, _args, _opts, callback) => {
    callback(failure ? Object.assign(new Error("private stderr must not be displayed"), failure) : null, "", "");
  });
  const instance = await KimiAgentDriver.create({ instanceId: "fixture", displayName: undefined, environment: {}, enabled: true, config: { cli: "kimi", fullAuto: false } });
  try {
    const snapshot = await instance.snapshot();
    expect(snapshot.state).toBe("unavailable");
    expect(snapshot.reason).toContain(reason);
    expect(snapshot.reason).not.toContain("private stderr");
  } finally { await instance.dispose(); }
});

it("detects a newly installed and then signed-in fake Kimi without recreating the driver", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-kimi-detection-"));
  const cli = join(home, "fake-kimi.cjs");
  const kimiHome = join(home, ".kimi-code");
  const instance = await KimiAgentDriver.create({
    instanceId: "fixture", displayName: undefined, enabled: true,
    environment: { HOME: home, USERPROFILE: home, KIMI_CODE_HOME: kimiHome },
    config: { cli: `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}`, fullAuto: false },
  });
  try {
    expect((await instance.snapshot()).state).toBe("unavailable");
    writeFileSync(cli, "console.log('kimi-fixture 1.0.0');\n");
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false, version: "kimi-fixture 1.0.0" });
    mkdirSync(join(kimiHome, "credentials"), { recursive: true });
    writeFileSync(join(kimiHome, "credentials", "kimi-code.json"), "{}");
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
  } finally {
    await instance.dispose();
    await removeTempDir(home);
  }
});
