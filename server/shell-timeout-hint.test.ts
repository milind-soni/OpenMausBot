import { describe, expect, it } from "vitest";

import { shellTimeoutHint } from "./shell-timeout-hint.ts";

// Claude Code 2.1.296's error text for a Bash call killed at its limit.
const TIMED_OUT = "Exit code 143\nCommand timed out after 2m 0s";

describe("shellTimeoutHint", () => {
  it("tells a timed-out media command to rerun with a longer timeout in the foreground", () => {
    const hint = shellTimeoutHint("Bash", { command: "ffmpeg -i in.mp3 -ar 16000 out.wav" }, TIMED_OUT)!;
    expect(hint).toContain("Do not rerun it the same way");
    expect(hint).toContain("`timeout`");
    expect(hint).toContain("600000");
    expect(hint).toContain("foreground");
    expect(hint).not.toContain("nohup");
    expect(hint).not.toContain("detached");
    expect(hint).not.toContain("mdfind");
  });

  it("points a timed-out whole-disk find at mdfind or a scoped folder", () => {
    for (const command of ["find / -iname '*.bin'", "ls; find / -name model.bin", "sudo find / -name x", "(find / -type f)"]) {
      const hint = shellTimeoutHint("Bash", { command }, TIMED_OUT)!;
      expect(hint, command).toContain("mdfind -name");
      expect(hint, command).toContain("-maxdepth");
    }
  });

  it("does not mistake a scoped find for a disk scan", () => {
    for (const command of ["find /tmp/work -name '*.wav'", "find . -name x", "find ~/Music -name x"]) {
      expect(shellTimeoutHint("Bash", { command }, TIMED_OUT), command).not.toContain("mdfind");
    }
  });

  it("stays quiet for other failures and other tools", () => {
    expect(shellTimeoutHint("Bash", { command: "false" }, "Exit code 1")).toBeNull();
    expect(shellTimeoutHint("Read", { file_path: "a" }, TIMED_OUT)).toBeNull();
    expect(shellTimeoutHint("Bash", { command: "x" }, undefined)).toBeNull();
    expect(shellTimeoutHint("Bash", undefined, TIMED_OUT)).toContain("`timeout`");
  });
});
