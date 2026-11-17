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
  const pid = (offset: number) => process.pid + 10_000 + offset;
  for (const platform of ["linux", "darwin"] as const) {
    it(`keeps breadth-first parent order and sibling enumeration order on ${platform}`, () => {
      fixture.rows = [
        { pid: pid(33), parent: pid(31) }, { pid: pid(22), parent: pid(20) }, { pid: pid(32), parent: pid(20) },
        { pid: pid(31), parent: pid(22) }, { pid: pid(99), parent: pid(98) }, { pid: pid(20), parent: pid(10) },
      ];
      expect(descendantsOf(pid(20), platform).map(row => row.pid)).toEqual([22, 32, 31, 33].map(pid));
    });
    it(`walks through dead parents without returning them on ${platform}`, () => {
      fixture.rows = [{ pid: pid(21), parent: pid(20), state: "Z" }, { pid: pid(22), parent: pid(21) }];
      expect(descendantsOf(pid(20), platform)).toEqual([{ pid: pid(22), start: `start-${pid(22)}` }]);
    });
    it(`does not revisit cycles or include the current process or its children on ${platform}`, () => {
      fixture.rows = [
        { pid: pid(21), parent: pid(20) }, { pid: pid(20), parent: pid(21) },
        { pid: process.pid, parent: pid(20) }, { pid: pid(23), parent: process.pid },
        { pid: 1, parent: pid(20) }, { pid: 0, parent: pid(20) },
      ];
      expect(descendantsOf(pid(20), platform).map(row => row.pid)).toEqual([pid(21)]);
    });
  }
  it("skips disappearing Linux processes and keeps the observed start identity", () => {
    fixture.rows = [{ pid: pid(21), parent: pid(20), start: "12345" }, { pid: pid(22), parent: pid(20) }];
    fixture.unreadable.add(pid(22));
    const tree = descendantsOf(pid(20), "linux");
    expect(tree).toEqual([{ pid: pid(21), start: "12345" }]);
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
    fixture.rows = [{ pid: pid(21), parent: pid(20) }];
    expect(descendantsOf(pid(20), "win32")).toEqual([]);
    expect(fixture.scans).toBe(0);
  });
});
