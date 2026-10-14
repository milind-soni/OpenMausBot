import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { recordProjectEvidence, projectEvidenceStatus, verifyProjectEvidence, openEvidenceArtifact } from "./project-evidence.ts";
import { TeamMemory } from "./team-memory.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omb-evidence-"));
  writeFileSync(join(root, "project.aep"), "saved revision one");
  writeFileSync(join(root, "preview.png"), "synthetic preview");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const input = { project: "project.aep", artifacts: ["preview.png"], stage: "checked" as const, check: "Compared the preview to the approved brief" };

it("records fingerprints without treating the agent's check as user approval", async () => {
  const evidence = await recordProjectEvidence(root, input);
  expect(evidence.project.sha256).toHaveLength(64);
  expect(projectEvidenceStatus(evidence)).toBe("agent-checked");
  expect(await verifyProjectEvidence(evidence)).toBe(true);
  const memory = new TeamMemory(join(root, "team.json"));
  const { entry } = memory.propose("", { kind: "outcome", name: "Title fix", detail: "Title repositioned" }, { botId: "b", botName: "B", threadId: "t", at: 1 }, evidence);
  memory.resolve("", entry.id, "accept");
  expect(memory.list("")[0].evidenceStatus).toBe("agent-checked");
  memory.approveEvidence("", entry.id, memory.list("")[0].revision!);
  expect(memory.list("")[0].evidenceStatus).toBe("approved");
  writeFileSync(join(root, "project.aep"), "saved revision two");
  expect(memory.list("")[0].evidenceStatus).toBe("stale");
  expect(memory.systemPrompt("")).toContain("stale");
  expect(await verifyProjectEvidence(evidence)).toBe(false);
});

it("marks missing or edited preview evidence stale and blocks approval", async () => {
  const evidence = await recordProjectEvidence(root, input);
  rmSync(join(root, "preview.png"));
  expect(projectEvidenceStatus(evidence)).toBe("stale");
  expect(await verifyProjectEvidence(evidence)).toBe(false);
});

it("refuses paths and symlinks outside the project", async () => {
  await expect(recordProjectEvidence(root, { ...input, project: "../does-not-exist.aep" })).rejects.toThrow();
  const outside = mkdtempSync(join(tmpdir(), "omb-outside-"));
  try {
    writeFileSync(join(outside, "private.aep"), "outside");
    symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    await expect(recordProjectEvidence(root, { ...input, project: "link/private.aep" })).rejects.toThrow(/inside/);
  } finally { rmSync(outside, { recursive: true, force: true }); }
});


it("allows an unchanged preview after the project changes, but rejects changed previews", async () => {
  const evidence = await recordProjectEvidence(root, input);
  writeFileSync(join(root, "project.aep"), "new project");
  const opened = await openEvidenceArtifact(evidence, 0);
  try { expect(await opened.handle.readFile("utf8")).toBe("synthetic preview"); }
  finally { await opened.handle.close(); }
  writeFileSync(join(root, "preview.png"), "changed preview");
  await expect(openEvidenceArtifact(evidence, 0)).rejects.toThrow(/changed/);
});
