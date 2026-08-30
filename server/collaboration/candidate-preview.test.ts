import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderCandidateDiffPreview } from "./candidate-preview.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repository(): { path: string; baseSha: string } {
  const path = mkdtempSync(join(tmpdir(), "candidate-preview-"));
  scratch.push(path);
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.name", "Preview Test"]);
  execFileSync("git", ["-C", path, "config", "user.email", "preview@example.invalid"]);
  writeFileSync(join(path, "pilot-output.txt"), "pending\n");
  writeFileSync(join(path, ".env"), "TOKEN=baseline-secret\n");
  execFileSync("git", ["-C", path, "add", "--", "pilot-output.txt", ".env"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "baseline"]);
  return {
    path,
    baseSha: execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
}

describe("candidate diff preview", () => {
  it("shows validated candidate content but excludes sensitive paths", () => {
    const fixture = repository();
    writeFileSync(join(fixture.path, "pilot-output.txt"), "hello pilot\n");
    writeFileSync(join(fixture.path, ".env"), "TOKEN=candidate-secret\n");
    execFileSync("git", ["-C", fixture.path, "add", "--", "pilot-output.txt", ".env"]);
    execFileSync("git", ["-C", fixture.path, "commit", "-qm", "candidate"]);
    const resultSha = execFileSync("git", ["-C", fixture.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const preview = renderCandidateDiffPreview({
      repository: fixture.path,
      baseSha: fixture.baseSha,
      resultSha,
      changedPaths: ["pilot-output.txt", ".env"],
    });
    expect(preview).toContain("-pending");
    expect(preview).toContain("+hello pilot");
    expect(preview).not.toContain("candidate-secret");
    expect(preview).not.toContain(".env");
  });

  it("truncates large diffs at the configured character bound", () => {
    const fixture = repository();
    writeFileSync(join(fixture.path, "pilot-output.txt"), `${"hello pilot\n".repeat(500)}`);
    execFileSync("git", ["-C", fixture.path, "add", "--", "pilot-output.txt"]);
    execFileSync("git", ["-C", fixture.path, "commit", "-qm", "candidate"]);
    const resultSha = execFileSync("git", ["-C", fixture.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const preview = renderCandidateDiffPreview({
      repository: fixture.path,
      baseSha: fixture.baseSha,
      resultSha,
      changedPaths: ["pilot-output.txt"],
      maximumCharacters: 512,
    });
    expect(preview?.length).toBeLessThanOrEqual(512);
    expect(preview?.endsWith("… candidate diff truncated")).toBe(true);
  });
});
