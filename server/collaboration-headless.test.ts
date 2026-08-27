import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openCollaborationLedger } from "./collaboration/db.ts";
import { LocalOwnerRegistry } from "./collaboration/owner.ts";
import { parseHeadlessArguments, runCollaborationHeadless, type HeadlessIo } from "./collaboration-headless.ts";
import { CollaborationHeadlessRuntime, type CollaborationHeadlessRuntimeOptions } from "./collaboration/operations/runtime.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "collaboration-headless-"));
  scratch.push(path);
  return path;
}

function io(input = ""): { io: HeadlessIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdin: Readable.from([input]),
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
      once() {},
      off() {},
    },
  };
}

describe("secure collaboration headless CLI", () => {
  it("prints health and cleanly starts/stops with Stream disabled", async () => {
    const output = io();
    const dataDirectory = temporaryDirectory();
    let receivedOptions: CollaborationHeadlessRuntimeOptions | undefined;
    const health = await runCollaborationHeadless(
      ["--health", "--data-dir", dataDirectory],
      { OMB_DINGTALK_ENABLED: "0" },
      {
        io: output.io,
        createRuntime(options) {
          receivedOptions = options;
          return new CollaborationHeadlessRuntime(options);
        },
      },
    );
    expect(health).toMatchObject({ status: "healthy", ready: true, dingtalk: { state: "disabled" } });
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({ status: "healthy", ready: true });
    expect(receivedOptions).toMatchObject({ probeOnly: true });
    expect(receivedOptions?.outboxDelivery).toBeUndefined();
    const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    expect(database.prepare("SELECT owner_id FROM collaboration_instance_lease WHERE singleton = 1").get()).toBeUndefined();
    database.close();
  });

  it("never accepts Owner corp/staff identity as command-line values", () => {
    expect(() => parseHeadlessArguments(["--recover-owner", "--sender-corp-id", "secret"], {})).toThrow(
      "Unknown argument",
    );
  });

  it("recovers the sole Owner from an absolute secure reference without echoing identity", async () => {
    const dataDirectory = temporaryDirectory();
    const ledger = openCollaborationLedger(join(dataDirectory, "collaboration"));
    const owner = new LocalOwnerRegistry(ledger.filePath);
    owner.bootstrap({ senderCorpId: "old-corp", senderStaffId: "old-staff", now: 1 });
    owner.close();
    ledger.close();

    const identityFile = join(dataDirectory, "owner-recovery.json");
    writeFileSync(identityFile, JSON.stringify({ senderCorpId: "new-corp", senderStaffId: "new-staff" }), { mode: 0o600 });
    chmodSync(identityFile, 0o600);
    const output = io();
    await runCollaborationHeadless(
      [
        "--recover-owner",
        "--expected-generation",
        "1",
        "--identity-file",
        identityFile,
        "--data-dir",
        dataDirectory,
      ],
      {},
      { io: output.io },
    );
    expect(output.stdout.join(""))
      .toBe(`${JSON.stringify({ status: "owner_recovered", generation: 2 })}\n`);
    expect(output.stdout.join("")).not.toContain("new-corp");
    const reopened = openCollaborationLedger(join(dataDirectory, "collaboration"));
    const registry = new LocalOwnerRegistry(reopened.filePath);
    expect(registry.active()).toMatchObject({ senderCorpId: "new-corp", senderStaffId: "new-staff", generation: 2 });
    registry.close();
    reopened.close();
  });

  it("requires exactly one explicit recovery identity source", () => {
    expect(() => parseHeadlessArguments(["--recover-owner", "--expected-generation", "1"], {})).toThrow(
      "owner_recovery_requires_generation_and_identity_source",
    );
    expect(() =>
      parseHeadlessArguments(
        ["--recover-owner", "--expected-generation", "1", "--identity-stdin", "--identity-file", "/tmp/id"],
        {},
      ),
    ).toThrow("owner_identity_source_must_be_unique");
  });
});
