import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FIRST_MILESTONE_DEFAULTS, OPENMAUSBOT_SOURCE_BASELINE } from "./config.ts";
import { startCollaborationService } from "./service.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-collaboration-service-"));
  scratch.push(directory);
  return directory;
}

describe("headless collaboration service", () => {
  it("reports stable health without an Electron lifecycle", () => {
    const service = startCollaborationService({ dataDirectory: temporaryDirectory() });
    expect(service.health()).toEqual({
      app: "openmausbot-collaboration",
      status: "healthy",
      ready: true,
      sourceBaseline: OPENMAUSBOT_SOURCE_BASELINE,
      authority: "headless",
      database: {
        file: "collaboration.sqlite",
        schemaVersion: 3,
        appliedMigrations: 3,
        journalMode: "wal",
        foreignKeys: true,
      },
      defaults: FIRST_MILESTONE_DEFAULTS,
    });
    service.close();
    expect(() => service.health()).toThrow("Collaboration service is closed");
  });

  it("defaults all deferred execution capabilities to disabled", () => {
    expect(FIRST_MILESTONE_DEFAULTS).toEqual({
      executionMode: "observe",
      singleOwner: true,
      headlessAuthority: true,
      multiAgentConcurrency: false,
      integrationBranch: false,
      durableApprovals: false,
      previewDeployment: false,
      defaultBranchMerge: false,
      productionDeployment: false,
    });
  });

  it("offers a one-shot health command for clean-environment probes", () => {
    const directory = temporaryDirectory();
    const entry = resolve("server/collaboration-headless.ts");
    const output = execFileSync(process.execPath, ["--experimental-strip-types", entry, "--health", "--data-dir", directory], {
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toMatchObject({
      app: "openmausbot-collaboration",
      status: "healthy",
      ready: true,
      authority: "headless",
      database: { schemaVersion: 3, appliedMigrations: 3 },
      defaults: { executionMode: "observe", multiAgentConcurrency: false, previewDeployment: false },
    });
  });
});
