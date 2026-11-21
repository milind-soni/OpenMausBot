import { describe, expect, it } from "vitest";

import { availableMB, codeLocation, pressure10, stallLine, stealPercent, summarizeProfile, threadState, type CpuProfile, type StallRecord } from "./stall-sample.ts";

const frame = (functionName: string, url = "", lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 4 });

describe("codeLocation", () => {
  it("keeps the file's place in the app and drops the machine's paths", () => {
    const root = "/home/ada/OpenMausBot";
    expect(codeLocation(frame("redactSecretsInText", "file:///home/ada/OpenMausBot/shared/redact.ts", 92), root)).toBe("redactSecretsInText shared/redact.ts:93:5");
    expect(codeLocation(frame("x", "file:///app/dist-server/index.js", 10), "/app")).toBe("x dist-server/index.js:11:5");
    expect(codeLocation(frame("parse", "file:///Users/ada/app/node_modules/@scope/pkg/lib/a.js"), "/Users/ada/app")).toBe("parse @scope/pkg/lib/a.js:1:5");
    expect(codeLocation(frame("readFileSync", "node:fs"), root)).toBe("readFileSync node:fs:1:5");
    expect(codeLocation(frame("", "file:///secret/place/thing.js"), root)).toBe("(anonymous) thing.js:1:5");
    expect(codeLocation(frame("(garbage collector)"))).toBe("(garbage collector)");
    expect(codeLocation({ ...frame("inlined", "file:///app/dist-server/index.js"), lineNumber: -1 }, "/app")).toBe("inlined dist-server/index.js");
  });

  it("matches the app's own folder, not a `packages` or `server` folder above it", () => {
    const root = "/srv/packages/server/OpenMausBot";
    expect(codeLocation(frame("tick", `file://${root}/server/perf/x.ts`, 1), root)).toBe("tick server/perf/x.ts:2:5");
    expect(codeLocation(frame("tick", "file:///srv/packages/other/y.ts", 1), root)).toBe("tick y.ts:2:5");
  });

  it("finds the app's own folder in a Windows path or file URL", () => {
    const root = "C:\\a\\OpenMausBot";
    expect(codeLocation(frame("tick", "file:///C:/a/OpenMausBot/server/perf/x.ts", 1), root)).toBe("tick server/perf/x.ts:2:5");
    expect(codeLocation(frame("tick", "C:\\a\\OpenMausBot\\server\\perf\\x.ts", 1), root)).toBe("tick server/perf/x.ts:2:5");
    expect(codeLocation(frame("tick", "file:///c:/a/OpenMausBot/server/perf/x.ts", 1), root)).toBe("tick server/perf/x.ts:2:5");
    expect(codeLocation(frame("tick", "file:///D:/elsewhere/y.ts", 1), root)).toBe("tick y.ts:2:5");
  });

  it("never carries a function name that isn't an identifier", () => {
    expect(codeLocation(frame("evil\nname with \"quotes\"", "file:///app/server/a.ts"), "/app")).toBe("(anonymous) server/a.ts:1:5");
  });
});

describe("summarizeProfile", () => {
  it("names the busiest frames and the stack to the busiest leaf", () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame("(root)"), children: [2, 5] },
        { id: 2, callFrame: frame("handle", "file:///app/server/index.ts", 9), children: [3] },
        { id: 3, callFrame: frame("redact", "file:///app/shared/redact.ts", 99), children: [4] },
        { id: 4, callFrame: frame("replace", "", 0) },
        { id: 5, callFrame: frame("(idle)") },
      ],
      samples: [4, 4, 4, 3, 5, 5, 5, 5, 5],
    };
    const summary = summarizeProfile(profile, "/app");
    expect(summary.top[0]).toEqual({ at: "(idle)", samples: 5 });
    expect(summary.top[1]).toEqual({ at: "replace", samples: 3 });
    expect(summary.stack).toEqual(["handle server/index.ts:10:5", "redact shared/redact.ts:100:5", "replace"]);
  });

  it("copes with an empty profile", () => {
    expect(summarizeProfile({ nodes: [], samples: [] })).toEqual({ top: [], stack: [] });
  });
});

describe("/proc readings", () => {
  it("reads a thread's state and wait channel", () => {
    expect(threadState("1234 (MainThread) D 1 1234 1234 0 -1", "folio_wait_bit_common")).toEqual({ state: "D", wchan: "folio_wait_bit_common" });
    expect(threadState("1234 (node (x)) R 1", "0")).toEqual({ state: "R", wchan: null });
    expect(threadState(null, null)).toEqual({ state: null, wchan: null });
  });

  it("reads memory, pressure and steal", () => {
    expect(availableMB("MemTotal:  2000000 kB\nMemAvailable:    7168 kB\n")).toBe(7);
    expect(pressure10("some avg10=12.50 avg60=1 avg300=0 total=1\nfull avg10=70.26 avg60=2 avg300=0 total=1\n", "full")).toBe(70.26);
    expect(pressure10(null, "some")).toBeNull();
    expect(stealPercent("cpu  100 0 100 700 0 0 0 100 0 0\n", "cpu  110 0 110 720 0 0 0 160 0 0\n")).toBe(60);
    expect(stealPercent("cpu 1 2\n", null)).toBeNull();
  });
});

describe("stallLine", () => {
  const base: StallRecord = {
    at: 0, blockedSinceMs: 12_400, kind: "js", top: [{ at: "redact shared/redact.ts:100:5", samples: 1800 }], stack: ["handle server/index.ts:10:5", "redact shared/redact.ts:100:5"],
    thread: { state: "R", wchan: null }, machine: { availableMB: 2300, memoryFull10: 0, cpuSome10: 1, stealPct: 0 }, memory: [{ bucket: "server", rssMB: 520, procs: 1 }],
  };

  it("says where the thread is and what the machine looks like", () => {
    expect(stallLine(base)).toBe("main thread blocked 12s, in JavaScript: redact shared/redact.ts:100:5 (1800); stack handle server/index.ts:10:5 > redact shared/redact.ts:100:5; "
      + "memory available 2300 MB, memory stall 0%, cpu stall 1%, steal 0%; largest: server 520 MB");
  });

  it("says why there is no profile", () => {
    const line = stallLine({ ...base, kind: "not-profiled", why: "memory", top: [], stack: [], thread: { state: "D", wchan: null } });
    expect(line).toContain("main thread blocked 12s, not profiled, memory too short to profile (thread state D)");
    expect(stallLine({ ...base, kind: "not-profiled", why: "no-inspector", top: [], stack: [] })).toContain("not profiled, no inspector here");
  });

  it("says when the thread was outside JavaScript", () => {
    const line = stallLine({ ...base, kind: "outside-js", top: [], stack: [], thread: { state: "D", wchan: "folio_wait_bit_common" },
      machine: { availableMB: 7, memoryFull10: 70.3, cpuSome10: null, stealPct: null }, memory: [{ bucket: "browser", rssMB: 2864, procs: 1 }] });
    expect(line).toBe("main thread blocked 12s, outside JavaScript (thread state D, waiting in folio_wait_bit_common); memory available 7 MB, memory stall 70.3%, cpu stall ?, steal ?; largest: browser 2864 MB");
  });
});
