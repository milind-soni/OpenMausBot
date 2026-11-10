import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { KEYRING_PROBES, keyringDenied } from "./box-probe.ts";

const missing = () => ({ error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), status: null });
const printed = (stdout: string) => ({ stdout, stderr: "", status: 0 });

describe("the keyring check of the box's seccomp filter", () => {
  it("passes only when the call is refused with EPERM", () => {
    expect(keyringDenied(() => printed("errno 1\n"))).toEqual([true, "python3: errno 1"]);
    expect(keyringDenied(() => printed("ok"))).toEqual([false, "python3: ok"]);
    expect(keyringDenied(() => printed("errno 38"))).toEqual([false, "python3: errno 38"]);
    expect(keyringDenied(() => ({ stdout: "", stderr: "", status: null }))).toEqual([false, "python3: exit null"]);
  });

  it("makes the call with perl where there is no python3, as in the self-hosted server's image", () => {
    const tried: string[] = [];
    const verdict = keyringDenied((command) => { tried.push(command); return command === "python3" ? missing() : printed("errno 1"); });
    expect(tried).toEqual(["python3", "perl"]);
    expect(verdict).toEqual([true, "perl: errno 1"]);
    expect(keyringDenied((command) => (command === "python3" ? missing() : printed("ok")))).toEqual([false, "perl: ok"]);
  });

  it("fails, and says why, where nothing can make the call", () => {
    expect(keyringDenied(missing)).toEqual([false, "could not be checked: neither python3 nor perl is in this image"]);
  });

  // Each interpreter this machine has must really make the call and answer in the words the check reads: `ok` where
  // nothing refuses it, an errno where something does (a container's own filter refuses it with EPERM). Only x86-64
  // Linux, whose call number the filter and the probes are written for.
  it.runIf(process.platform === "linux" && process.arch === "x64")("really makes the call with each interpreter this machine has", () => {
    for (const probe of KEYRING_PROBES) {
      const result = spawnSync(probe.command, probe.args, { encoding: "utf8", timeout: 10_000 });
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
      expect(`${probe.command}: ${result.stdout.trim()}${result.stderr.trim()}`).toMatch(new RegExp(`^${probe.command}: (ok|errno \\d+)$`));
    }
  });
});
