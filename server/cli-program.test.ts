import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { cliProgramFile, noteProbeUnsettled, probeUnsettled } from "./cli-program.ts";

const scratch: string[] = [];
afterEach(async () => { for (const dir of scratch.splice(0)) await removeTempDir(dir); });

describe("the program file a CLI runs", () => {
  it("is found on the PATH given, or as given when it is a path, and only when it is a file", () => {
    const bin = mkdtempSync(join(tmpdir(), "omb-cli-program-"));
    scratch.push(bin);
    const exe = process.platform === "win32" ? ".exe" : "";
    writeFileSync(join(bin, `opencode${exe}`), "");
    // Windows finds it by PATHEXT, whose case (".EXE") it keeps; file names there are not case-sensitive.
    const found = cliProgramFile("opencode", ["", join(bin, "missing"), bin].join(delimiter));
    expect(process.platform === "win32" ? found?.toLowerCase() : found).toBe(process.platform === "win32" ? join(bin, "opencode.exe").toLowerCase() : join(bin, "opencode"));
    expect(cliProgramFile(`"${join(bin, `opencode${exe}`)}" acp`, "")).toBe(join(bin, `opencode${exe}`));
    expect(cliProgramFile("codex", bin)).toBeNull();
    expect(cliProgramFile(bin, "")).toBeNull(); // a folder
    expect(cliProgramFile("", bin)).toBeNull();
    // A Windows path that is not there is simply not found, on any platform.
    expect(cliProgramFile("D:\\\\Tools\\\\opencode.cmd", "")).toBeNull();
    expect(cliProgramFile("d:/tools/opencode.exe", "")).toBeNull();
  });

  it("remembers which CLIs have a check that could not finish, so a check again runs the program", () => {
    noteProbeUnsettled("opencode", true);
    expect(probeUnsettled("opencode")).toBe(true);
    expect(probeUnsettled("codex")).toBe(false);
    noteProbeUnsettled("opencode", false);
    expect(probeUnsettled("opencode")).toBe(false);
  });
});
