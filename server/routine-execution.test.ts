import { describe, expect, it } from "vitest";

import { composeExecutionPrompt, foreignPaths, routineHostWarning } from "./routine-execution.ts";

describe("foreignPaths", () => {
  it("finds Windows paths on Linux and macOS, but not URLs, times or data URIs", () => {
    const text = "Read C:\\Users\\Ada\\notes.txt, then d:/exports/q3.csv and \\\\fileserver\\share\\plan.docx; see https://example.com/Users/x at 10:30 (data:/x).";
    expect(foreignPaths([text], "linux")).toEqual(["C:\\Users\\Ada\\notes.txt", "d:/exports/q3.csv", "\\\\fileserver\\share\\plan.docx"]);
    expect(foreignPaths([text], "darwin")).toEqual(["C:\\Users\\Ada\\notes.txt", "d:/exports/q3.csv", "\\\\fileserver\\share\\plan.docx"]);
    expect(foreignPaths([text], "win32")).toEqual([]);
  });

  it("finds macOS paths on Linux, and POSIX home paths on Windows", () => {
    expect(foreignPaths(["Copy /Users/ada/Desktop/report.pdf to /home/ada/out."], "linux")).toEqual(["/Users/ada/Desktop/report.pdf"]);
    expect(foreignPaths(["Copy /Users/ada/Desktop/report.pdf to /home/ada/out."], "darwin")).toEqual(["/home/ada/out"]);
    expect(foreignPaths(["Copy /Users/ada/Desktop/report.pdf to /home/ada/out."], "win32")).toEqual(["/Users/ada/Desktop/report.pdf", "/home/ada/out"]);
    expect(foreignPaths(["Open ~/Users/notes and ./home/x"], "linux")).toEqual([]);
  });

  it("names the host that runs a cloud routine as Linux whatever this computer is", () => {
    const routine = { prompt: "Total E:\\ledger.xlsx", runOn: "cloud" as const };
    expect(routineHostWarning(routine, "win32")).toContain("cannot exist on the Linux computer that runs it");
    expect(routineHostWarning({ ...routine, runOn: "maus" }, "win32")).toBeUndefined();
  });
});

describe("composeExecutionPrompt", () => {
  it("heads scheduled and manual runs with what to do now, and leaves webhook runs to their own boundary", () => {
    expect(composeExecutionPrompt({ id: "routine-id", name: "Daily [brief]\n", trigger: "schedule", runOn: "maus" }, "Write it", undefined))
      .toBe('[Scheduled routine "Daily brief" — do this now:]\nTrigger id: routine-id\nWrite it');
    expect(composeExecutionPrompt({ id: "routine-id", name: "Daily", trigger: "startup", runOn: "maus" }, "Write it", undefined))
      .toBe('[Routine "Daily" — do this now:]\nTrigger id: routine-id\nWrite it');
    expect(composeExecutionPrompt({ id: "hook-id", name: "Hook", trigger: "webhook", runOn: "maus" }, "Payload block", undefined)).toBe("Payload block");
  });
});
