import { describe, expect, it } from "vitest";
import { softExitCode } from "./tool-exit";

const listing = "drwxr-xr-x  4 user staff 128 Oct 13 12:15 New Photos\n/usr/local/bin/ffprobe\n/usr/bin/mdls";

describe("softExitCode", () => {
  it("downgrades a non-zero exit that still printed real output", () => {
    expect(softExitCode({ name: "Bash", ok: false, output: `Exit code 1\n${listing}` })).toBe(1);
    expect(softExitCode({ name: "Bash", ok: false, output: `Exit code 2\r\n${listing}` })).toBe(2);
    expect(softExitCode({ name: "Bash", ok: false, output: `Exit code 1\n${"x".repeat(150)}` })).toBe(1);
  });
  it("reads content blocks the server previewed as JSON", () => {
    const output = JSON.stringify([{ type: "text", text: `Exit code 1\n${listing}` }], null, 2);
    expect(softExitCode({ name: "Bash", ok: false, output })).toBe(1);
  });
  it("covers command-titled chips from other engines", () => {
    expect(softExitCode({ name: "ls -la | grep photos", ok: false, output: `Exit code 1\n${listing}` })).toBe(1);
  });
  it("keeps timeouts, kills and empty or one-line failures as failures", () => {
    expect(softExitCode({ name: "Bash", ok: false, output: `Exit code 143\n${listing}` })).toBeNull();
    expect(softExitCode({ name: "Bash", ok: false, output: `Exit code 137\n${listing}` })).toBeNull();
    expect(softExitCode({ name: "Bash", ok: false, output: `Exit code 1\n${listing}\nCommand timed out after 2m 0s` })).toBeNull();
    expect(softExitCode({ name: "Bash", ok: false, output: "Exit code 1" })).toBeNull();
    expect(softExitCode({ name: "Bash", ok: false, output: "Exit code 1\ncat: missing.txt: No such file or directory" })).toBeNull();
    expect(softExitCode({ name: "Bash", ok: false })).toBeNull();
  });
  it("ignores results that are not a plain exit status", () => {
    expect(softExitCode({ name: "Bash", ok: false, output: `Permission denied\n${listing}` })).toBeNull();
    expect(softExitCode({ name: "Bash", ok: true, output: `Exit code 1\n${listing}` })).toBeNull();
    expect(softExitCode({ name: "Bash", ok: false, output: `Exit code 0\n${listing}` })).toBeNull();
    expect(softExitCode({ name: "Read", ok: false, output: `Exit code 1\n${listing}` })).toBeNull();
  });
});
