import { describe, expect, it } from "vitest";
import { OOM_SCORE, protectInit } from "./oom-score.ts";

const linux = process.platform === "linux";

describe("the init a Cloud home's supervisor runs under", () => {
  it("gets the supervisor's score when it is tini, so memory never ends the container at its process 1", () => {
    const files = new Map([["/proc/1/comm", "tini\n"], ["/proc/1/oom_score_adj", "0\n"]]);
    const file = { read: (path: string) => files.get(path)!, write: (path: string, data: string) => { files.set(path, data); } };
    expect(protectInit(1, file)).toBe(linux);
    expect(files.get("/proc/1/oom_score_adj")!.trim()).toBe(linux ? String(OOM_SCORE.supervisor) : "0");
  });

  it("leaves any other parent alone: a host's own init, a shell, another supervisor", () => {
    for (const name of ["docker-init", "init", "sh", "node"]) {
      const written: string[] = [];
      expect(protectInit(7, { read: (path) => (path.endsWith("/comm") ? `${name}\n` : "0\n"), write: (path) => { written.push(path); } })).toBe(false);
      expect(written).toEqual([]);
    }
  });

  it("is false, not an error, where the score can't be read or set", () => {
    expect(protectInit(1, { read: () => { throw new Error("ENOENT"); }, write: () => {} })).toBe(false);
    expect(protectInit(1, { read: (path) => (path.endsWith("/comm") ? "tini\n" : "0\n"), write: () => { throw new Error("EACCES"); } })).toBe(false);
  });
});
