import { describe, expect, it } from "vitest";

import { draftWorkflow } from "./draft.ts";
import { workflowSchema } from "./format.ts";
import { burgerLayers, redirectTarget, type RunMessage } from "./layers.ts";

let sequence = 0;
const ask: RunMessage = { id: "ask", role: "user", kind: "text", text: "Prepare the reports" };
const tool = (name: string, input: Record<string, unknown>): RunMessage => ({
  id: `m${++sequence}`, role: "bot", kind: "activity", tool: { name, ok: true, input: JSON.stringify(input) },
});
const write = (path: string, content: string) => tool("Write", { file_path: path, content });
const shell = (command: string, cwd?: string) => tool("Bash", { command, ...(cwd ? { cwd } : {}) });

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
    const draft = draftWorkflow([ask, ...commands.map((command) => shell(command))]);
    expect(draft!.workflow.steps.map((step) => step.kind === "shell" && step.run)).toEqual(commands);
    expect(redirectTarget(commands[2]!)).toBe("north detailed.csv");
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

  it("keeps compound commands whose redirect does not identify every effect", () => {
    const commands = [
      "cd north && printf north > report.csv",
      "cd south && printf south > report.csv",
      "printf first > both.csv; printf other > extra.csv",
      "printf second > both.csv",
    ];
    const draft = draftWorkflow([ask, ...commands.map((command) => shell(command))]);
    expect(draft!.workflow.steps.map((step) => step.kind === "shell" && step.run)).toEqual(commands);
  });

  it("keeps a write consumed by a later command before the next rewrite", () => {
    const commands = [
      "printf north > report.csv", "cp report.csv north.csv",
      "printf south > report.csv", "cp report.csv south.csv",
    ];
    const draft = draftWorkflow([ask, ...commands.map((command) => shell(command))]);
    expect(draft!.workflow.steps.map((step) => step.kind === "shell" && step.run)).toEqual(commands);
  });

  it("keeps a write read between rewrites even when the read is not a layer", () => {
    const layers = burgerLayers([
      ask,
      write("report.csv", "Draft"),
      tool("Read", { file_path: "report.csv" }),
      write("report.csv", "Finished"),
    ]);
    expect(layers.map((layer) => layer.args?.content)).toEqual(["Draft", "Finished"]);
  });

  it.each(["printf first > first.csv > report.csv", "printf first >first.csv>report.csv"])("keeps every output of %s", (command) => {
    const commands = [command, "printf second > first.csv", "cp report.csv backup.csv"];
    const draft = draftWorkflow([ask, ...commands.map((one) => shell(one))]);
    expect(draft!.workflow.steps.map((step) => step.kind === "shell" && step.run)).toEqual(commands);
    expect(redirectTarget(command)).toBe("first.csv");
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
    expect(redirectTarget(commands[1]!)).toBe("report.csv");
  });

  it("still keeps the last complete rewrite of the same file in the same place", () => {
    const layers = burgerLayers([
      ask,
      write("/reports/summary.md", "Draft"),
      write("/reports/summary.md", "Revised"),
      write("/reports/summary.md", "Finished"),
      shell("printf draft > report.csv", "/reports"),
      shell("printf finished > report.csv", "/reports"),
    ]);
    expect(layers.map((layer) => [layer.args, layer.tries])).toEqual([
      [{ path: "/reports/summary.md", content: "Finished" }, 2],
      [{ command: "printf finished > report.csv", cwd: "/reports" }, 1],
    ]);
  });
});
