import { describe, expect, it } from "vitest";

import { draftWorkflow } from "./draft.ts";
import { workflowSchema } from "./format.ts";
import { burgerLayers, type RunMessage } from "./layers.ts";

let sequence = 0;
const ask: RunMessage = { id: "ask", role: "user", kind: "text", text: "Prepare the reports" };
const tool = (name: string, input: Record<string, unknown>): RunMessage => ({
  id: `m${++sequence}`, role: "bot", kind: "activity", tool: { name, ok: true, input: JSON.stringify(input) },
});
const write = (path: string, content: string) => tool("Write", { file_path: path, content });
const shell = (command: string, cwd?: string) => tool("Bash", { command, ...(cwd ? { cwd } : {}) });
const runs = (commands: string[]) => draftWorkflow([ask, ...commands.map((command) => shell(command))])!.workflow.steps.map((step) => step.kind === "shell" && step.run);

describe("file writes in a saved workflow", () => {
  it.each([
    ["/reports/north/summary.md", "/reports/south/summary.md"],
    ["C:\\reports\\north\\summary.md", "C:\\reports\\south\\summary.md"],
  ])("keeps both files when %s and %s have the same basename", (north, south) => {
    const draft = draftWorkflow([ask, write(north, "North totals"), write(south, "South totals")]);
    expect(draft).not.toBeNull();
    expect(draft!.workflow.steps.map((step) => step.kind === "file" && step.path)).toEqual([north, south]);
    expect(workflowSchema.safeParse(draft!.workflow).success).toBe(true);
  });

  it("keeps redirects to different directories and quoted filenames", () => {
    const commands = [
      "printf north > north/report.csv",
      "printf south > south/report.csv",
      'printf detail > "north detailed.csv"',
      'printf summary > "north summary.csv"',
    ];
    expect(runs(commands)).toEqual(commands);
  });

  it("keeps relative output paths in different working directories", () => {
    const draft = draftWorkflow([
      ask,
      shell("printf north > report.csv", "/reports/north"),
      shell("printf south > report.csv", "/reports/south"),
    ]);
    expect(draft).not.toBeNull();
    expect(draft!.workflow.steps.map((step) => step.kind === "shell" && step.cwd)).toEqual(["/reports/north", "/reports/south"]);
  });

  it("keeps the same filename written after moving into different folders", () => {
    const commands = ["cd north && printf north > report.csv", "cd south && printf south > report.csv"];
    expect(runs(commands)).toEqual(commands);
  });

  it("keeps an output written on different computers", () => {
    const command = "python make_report.py > report.csv";
    const layers = burgerLayers([
      ask,
      shell(command),
      tool("mcp__computer__exec", { command }),
      tool("mcp__localComputer__exec", { command }),
    ]);
    expect(layers.map((layer) => layer.where)).toEqual(["bot", "vm", "yourComputer"]);
    expect(layers.every((layer) => layer.tries === undefined)).toBe(true);
  });

  it("keeps the CSV header and every append before copying the finished report", () => {
    const commands = [
      "printf 'name,score\\n' > report.csv",
      "printf 'Ada,10\\n' >> report.csv",
      "printf 'Bob,20\\n' >> report.csv",
      "cp report.csv backup.csv",
    ];
    const draft = draftWorkflow([ask, ...commands.map((command) => shell(command))]);
    expect(draft!.workflow.steps.map((step) => step.kind === "shell" && step.run)).toEqual(commands);
    expect(draft!.layers.every((layer) => layer.tries === undefined)).toBe(true);
  });

  it("keeps a write, an append and a later rewrite of one file in order", () => {
    const commands = ["printf header > log.txt", "printf row >> log.txt", "printf fresh > log.txt"];
    expect(runs(commands)).toEqual(commands);
  });

  it("still keeps only the last try when the same full path is written again", () => {
    const layers = burgerLayers([
      ask,
      write("/reports/summary.md", "Draft"),
      shell("printf draft > ./out/../report.csv", "/reports"),
      write("/reports/summary.md", "Finished"),
      shell("printf finished > /reports/report.csv"),
    ]);
    expect(layers.map((layer) => [layer.args, layer.tries])).toEqual([
      [{ path: "/reports/summary.md", content: "Finished" }, 1],
      [{ command: "printf finished > /reports/report.csv" }, 1],
    ]);
  });
});
