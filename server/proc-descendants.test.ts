import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ rows: [] as Array<{ pid: number; parent: number; state?: string; start?: string }>, unreadable: new Set<number>(), scans: 0 }));
vi.mock("node:fs", () => ({
  readdirSync: () => { fixture.scans++; return [...fixture.rows.map(row => String(row.pid)), "self", "net"]; },
  readFileSync: (file: string) => {
    const pid = Number(file.split("/")[2]);
    const row = fixture.rows.find(candidate => candidate.pid === pid);
    if (!row || fixture.unreadable.has(pid)) throw new Error("process exited");
    const fields = [row.state ?? "S", String(row.parent), ...Array<string>(17).fill("0"), row.start ?? `start-${pid}`];
    return `${pid} (a name with ) parentheses) ${fields.join(" ")}`;
  },
}));
vi.mock("node:child_process", () => ({ execFileSync: () => fixture.rows.map(row => `${row.pid} ${row.parent} ${row.state ?? "S"} ${row.start ?? `start-${row.pid}`}`).join("\n") }));

import { descendantsOf, stillRunning } from "./proc-descendants.ts";

beforeEach(() => { fixture.rows = []; fixture.unreadable.clear(); fixture.scans = 0; });

describe("process descendants", () => {
  for (const platform of ["linux", "darwin"] as const) {
    it(`keeps breadth-first parent order and sibling enumeration order on ${platform}`, () => {
      fixture.rows = [
        { pid: 33, parent: 31 }, { pid: 22, parent: 20 }, { pid: 32, parent: 20 },
        { pid: 31, parent: 22 }, { pid: 99, parent: 98 }, { pid: 20, parent: 10 },
      ];
      expect(descendantsOf(20, platform).map(row => row.pid)).toEqual([22, 32, 31, 33]);
    });
    it(`walks through dead parents without returning them on ${platform}`, () => {
      fixture.rows = [{ pid: 21, parent: 20, state: "Z" }, { pid: 22, parent: 21 }];
      expect(descendantsOf(20, platform)).toEqual([{ pid: 22, start: "start-22" }]);
    });
    it(`does not revisit cycles or include the current process or its children on ${platform}`, () => {
      fixture.rows = [
        { pid: 21, parent: 20 }, { pid: 20, parent: 21 },
        { pid: process.pid, parent: 20 }, { pid: 23, parent: process.pid },
        { pid: 1, parent: 20 }, { pid: 0, parent: 20 },
      ];
      expect(descendantsOf(20, platform).map(row => row.pid)).toEqual([21]);
    });
  }
  it("skips disappearing Linux processes and keeps the observed start identity", () => {
    fixture.rows = [{ pid: 21, parent: 20, start: "12345" }, { pid: 22, parent: 20 }];
    fixture.unreadable.add(22);
    const tree = descendantsOf(20, "linux");
    expect(tree).toEqual([{ pid: 21, start: "12345" }]);
    fixture.rows[0]!.start = "new-process";
    expect(stillRunning(tree, "linux")).toEqual([]);
  });
  it("handles a deep tree iteratively and ignores unrelated rows", () => {
    const count = 2_000;
    const first = process.pid + 10_000;
    for (let i = count; i > 0; i--) fixture.rows.push({ pid: first + i, parent: first + i - 1 });
    fixture.rows.push({ pid: first + count + 1, parent: 2 });
    expect(descendantsOf(first, "linux").map(row => row.pid)).toEqual(Array.from({ length: count }, (_, i) => first + i + 1));
    expect(fixture.scans).toBe(1);
  });
  it("leaves Windows tree discovery to taskkill", () => {
    fixture.rows = [{ pid: 21, parent: 20 }];
    expect(descendantsOf(20, "win32")).toEqual([]);
    expect(fixture.scans).toBe(0);
  });
});
