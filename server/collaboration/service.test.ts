import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
        schemaVersion: 9,
        appliedMigrations: 9,
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
      database: { schemaVersion: 9, appliedMigrations: 9 },
      defaults: { executionMode: "observe", multiAgentConcurrency: false, previewDeployment: false },
    });
  });

  it("reports degraded health after an authoritative audit write fails", () => {
    const directory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory: directory });
    service.bootstrapOwnerLocally({ senderCorpId: "corp", senderStaffId: "owner", now: 1 });
    const created = service.ingestDingTalkMessage({
      sourceEventId: "degraded-event",
      transportMessageId: "degraded-transport",
      conversationId: "degraded-conversation",
      addressedToBot: true,
      text: "create work",
      sender: { senderCorpId: "corp", senderStaffId: "staff", senderId: "sender", displayName: "Contributor" },
      receivedAt: 2,
    });
    const database = new DatabaseSync(join(directory, "collaboration", "collaboration.sqlite"));
    database.exec(`
      CREATE TRIGGER test_service_reject_audit BEFORE INSERT ON collaboration_audit_events
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;
    `);
    expect(() =>
      service.issueOwnerAction({ action: "pause", workItemId: created.workItemId!, expectedVersion: 1, now: 3 }),
    ).toThrow("audit unavailable");
    expect(service.health()).toMatchObject({
      status: "degraded",
      ready: false,
      degradation: { reason: "audit_unwritable" },
    });
    database.close();
    service.close();
  });
});
