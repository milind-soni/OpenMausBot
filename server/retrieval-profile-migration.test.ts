import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyRetrievalProfileMigration,
  previewRetrievalProfileMigration,
  rollbackRetrievalProfileMigration,
} from "./retrieval-profile-migration.ts";

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const SOURCE_VERSION = "0.1.28";
const SOURCE_SHA = "a".repeat(40);

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "openmaus-profile-migration-"));
  const botsPath = join(dataDir, "bots.json");
  const original = JSON.stringify([
    { id: "bot-ada", name: "Ada", modelSelection: { instanceId: "qwen", model: "qwen-model" } },
    { id: "bot-same-name", name: "Ada", modelSelection: { instanceId: "claude", model: "claude-model" } },
    { id: "bot-codex", name: "Builder", modelSelection: { instanceId: "codex", model: "codex-model" } },
    { id: "bot-claude-two", name: "Writer", modelSelection: { instanceId: "claude", model: "claude-model" } },
    { id: "bot-codex-two", name: "Reviewer", modelSelection: { instanceId: "codex", model: "codex-model" } },
    { id: "bot-qwen-two", name: "Analyst", modelSelection: { instanceId: "qwen", model: "qwen-model" } },
    { id: "bot-hermes", name: "Operator", modelSelection: { instanceId: "hermes", model: "hermes-model" } },
  ], null, 2);
  writeFileSync(botsPath, original);
  return { dataDir, botsPath, original };
}

function phaseOne(dataDir: string) {
  return {
    dataDir,
    botIds: ["bot-ada"],
    profile: "task-scoped" as const,
    canaryPhase: 1 as const,
    sourceVersion: SOURCE_VERSION,
    sourceSha: SOURCE_SHA,
  };
}

function writeCanaryReceipt(input: {
  dataDir: string;
  phase: 1 | 2;
  canaryBotIds: { qwen: string; claude?: string; codex?: string };
  sourceVersion?: string;
  sourceSha?: string;
  restartPassed?: boolean;
  botsDigest?: string;
}) {
  const path = join(input.dataDir, `phase-${input.phase}-canary.json`);
  const bots = readFileSync(join(input.dataDir, "bots.json"), "utf8");
  const receipt = {
    schema: "openmaus.retrieval-profile-canary-receipt.v1",
    phase: input.phase,
    profile: "task-scoped",
    source_version: input.sourceVersion ?? SOURCE_VERSION,
    source_sha: input.sourceSha ?? SOURCE_SHA,
    restart_passed: input.restartPassed ?? true,
    bots_digest: input.botsDigest ?? digest(bots),
    canary_bot_ids: input.canaryBotIds,
  };
  const raw = JSON.stringify(receipt, null, 2);
  writeFileSync(path, raw);
  return { path, raw, digest: digest(raw) };
}

function enablePhaseOne(dataDir: string) {
  const input = phaseOne(dataDir);
  const preview = previewRetrievalProfileMigration(input);
  const receipt = applyRetrievalProfileMigration({ ...input, expectedDigest: preview.before_digest });
  return { preview, receipt };
}

describe("retrieval-profile bot-id migration", () => {
  it("previews without writing, then snapshots and atomically applies only exact bot ids", () => {
    const { dataDir, botsPath, original } = fixture();
    const input = phaseOne(dataDir);
    const preview = previewRetrievalProfileMigration(input);
    expect(preview).toMatchObject({
      before_digest: digest(original),
      changed_bot_ids: ["bot-ada"],
      unchanged_bot_ids: [],
      canary_phase: 1,
      source_version: SOURCE_VERSION,
      source_sha: SOURCE_SHA,
      prerequisite_canary_receipt: null,
    });
    expect(readFileSync(botsPath, "utf8")).toBe(original);

    const receipt = applyRetrievalProfileMigration({
      ...input,
      expectedDigest: preview.before_digest,
      now: new Date("2026-08-22T06:00:00Z"),
    });
    expect(receipt.applied).toBe(true);
    expect(receipt.backup_path).not.toBeNull();
    expect(readFileSync(receipt.backup_path!, "utf8")).toBe(original);
    expect(digest(readFileSync(botsPath, "utf8"))).toBe(receipt.after_digest);
    const bots = JSON.parse(readFileSync(botsPath, "utf8"));
    expect(bots.find((bot: { id: string }) => bot.id === "bot-ada").retrievalProfile).toBe("task-scoped");
    expect(bots.find((bot: { id: string }) => bot.id === "bot-same-name")).not.toHaveProperty("retrievalProfile");
  });

  it("is idempotent and does not create another backup for an already-applied profile", () => {
    const { dataDir } = fixture();
    enablePhaseOne(dataDir);
    const input = phaseOne(dataDir);
    const preview = previewRetrievalProfileMigration(input);
    const receipt = applyRetrievalProfileMigration({ ...input, expectedDigest: preview.before_digest });
    expect(receipt).toMatchObject({
      applied: false,
      changed_bot_ids: [],
      unchanged_bot_ids: ["bot-ada"],
      backup_path: null,
      receipt_path: null,
    });
  });

  it("refuses stale previews and unknown ids without changing bots.json", () => {
    const { dataDir, botsPath, original } = fixture();
    expect(() => applyRetrievalProfileMigration({
      ...phaseOne(dataDir),
      expectedDigest: "sha256:" + "0".repeat(64),
    })).toThrow(/changed after preview/);
    expect(readFileSync(botsPath, "utf8")).toBe(original);
    expect(() => previewRetrievalProfileMigration({
      dataDir,
      botIds: ["missing-bot"],
      profile: "task-scoped",
    })).toThrow(/unknown bot id/);
    expect(readFileSync(botsPath, "utf8")).toBe(original);
  });

  it("enforces Ada/Qwen, then one Claude plus one Codex, then every remaining bot", () => {
    const { dataDir, botsPath } = fixture();
    enablePhaseOne(dataDir);
    const phaseOneCanary = writeCanaryReceipt({
      dataDir,
      phase: 1,
      canaryBotIds: { qwen: "bot-ada" },
    });
    const phaseTwoInput = {
      dataDir,
      botIds: ["bot-same-name", "bot-codex"],
      profile: "task-scoped" as const,
      canaryPhase: 2 as const,
      sourceVersion: SOURCE_VERSION,
      sourceSha: SOURCE_SHA,
      canaryReceiptPath: phaseOneCanary.path,
    };
    const phaseTwoPreview = previewRetrievalProfileMigration(phaseTwoInput);
    expect(phaseTwoPreview.prerequisite_canary_receipt).toMatchObject({
      receipt_digest: phaseOneCanary.digest,
      phase: 1,
      restart_passed: true,
      canary_bot_ids: { qwen: "bot-ada" },
    });
    const phaseTwo = applyRetrievalProfileMigration({
      ...phaseTwoInput,
      expectedDigest: phaseTwoPreview.before_digest,
      expectedCanaryDigest: phaseTwoPreview.prerequisite_canary_receipt!.receipt_digest,
    });
    expect(phaseTwo.changed_bot_ids).toEqual(["bot-same-name", "bot-codex"]);

    const phaseTwoCanary = writeCanaryReceipt({
      dataDir,
      phase: 2,
      canaryBotIds: { qwen: "bot-ada", claude: "bot-same-name", codex: "bot-codex" },
    });
    const remaining = ["bot-claude-two", "bot-codex-two", "bot-qwen-two", "bot-hermes"];
    const phaseThreeInput = {
      dataDir,
      botIds: remaining,
      profile: "task-scoped" as const,
      canaryPhase: 3 as const,
      sourceVersion: SOURCE_VERSION,
      sourceSha: SOURCE_SHA,
      canaryReceiptPath: phaseTwoCanary.path,
    };
    const phaseThreePreview = previewRetrievalProfileMigration(phaseThreeInput);
    const phaseThree = applyRetrievalProfileMigration({
      ...phaseThreeInput,
      expectedDigest: phaseThreePreview.before_digest,
      expectedCanaryDigest: phaseThreePreview.prerequisite_canary_receipt!.receipt_digest,
    });
    expect(phaseThree.changed_bot_ids).toEqual(remaining);
    const bots = JSON.parse(readFileSync(botsPath, "utf8"));
    expect(bots.every((bot: { retrievalProfile?: string }) => bot.retrievalProfile === "task-scoped")).toBe(true);

    const idempotent = previewRetrievalProfileMigration(phaseThreeInput);
    expect(idempotent).toMatchObject({ changed_bot_ids: [], unchanged_bot_ids: remaining });
  });

  it("rejects out-of-order activation, wrong engines, duplicate ids, and unproven restart state", () => {
    const { dataDir } = fixture();
    expect(() => previewRetrievalProfileMigration({
      dataDir,
      botIds: ["bot-same-name", "bot-codex"],
      profile: "task-scoped",
      canaryPhase: 2,
      sourceVersion: SOURCE_VERSION,
      sourceSha: SOURCE_SHA,
    })).toThrow(/prior phase restart-canary receipt/);
    expect(() => previewRetrievalProfileMigration({
      ...phaseOne(dataDir),
      botIds: ["bot-same-name"],
    })).toThrow(/exact Ada\/Qwen bot id/);
    expect(() => previewRetrievalProfileMigration({
      ...phaseOne(dataDir),
      botIds: ["bot-ada", "bot-ada"],
    })).toThrow(/only once/);

    enablePhaseOne(dataDir);
    const failedRestart = writeCanaryReceipt({
      dataDir,
      phase: 1,
      canaryBotIds: { qwen: "bot-ada" },
      restartPassed: false,
    });
    expect(() => previewRetrievalProfileMigration({
      dataDir,
      botIds: ["bot-same-name", "bot-codex"],
      profile: "task-scoped",
      canaryPhase: 2,
      sourceVersion: SOURCE_VERSION,
      sourceSha: SOURCE_SHA,
      canaryReceiptPath: failedRestart.path,
    })).toThrow(/restart_passed/);
  });

  it("binds phase 2 apply to the exact source, current bot readback, and previewed canary receipt", () => {
    const { dataDir, botsPath } = fixture();
    enablePhaseOne(dataDir);
    const wrongSource = writeCanaryReceipt({
      dataDir,
      phase: 1,
      canaryBotIds: { qwen: "bot-ada" },
      sourceSha: "b".repeat(40),
    });
    const base = {
      dataDir,
      botIds: ["bot-same-name", "bot-codex"],
      profile: "task-scoped" as const,
      canaryPhase: 2 as const,
      sourceVersion: SOURCE_VERSION,
      sourceSha: SOURCE_SHA,
    };
    expect(() => previewRetrievalProfileMigration({ ...base, canaryReceiptPath: wrongSource.path }))
      .toThrow(/source version\/SHA/);

    const staleReadback = writeCanaryReceipt({
      dataDir,
      phase: 1,
      canaryBotIds: { qwen: "bot-ada" },
      botsDigest: `sha256:${"0".repeat(64)}`,
    });
    expect(() => previewRetrievalProfileMigration({ ...base, canaryReceiptPath: staleReadback.path }))
      .toThrow(/bots digest does not match/);

    const canary = writeCanaryReceipt({ dataDir, phase: 1, canaryBotIds: { qwen: "bot-ada" } });
    const input = { ...base, canaryReceiptPath: canary.path };
    const preview = previewRetrievalProfileMigration(input);
    const beforeAttempt = readFileSync(botsPath, "utf8");
    expect(() => applyRetrievalProfileMigration({ ...input, expectedDigest: preview.before_digest }))
      .toThrow(/exact digest was not supplied/);
    expect(readFileSync(botsPath, "utf8")).toBe(beforeAttempt);

    writeFileSync(canary.path, `${canary.raw}\n`);
    expect(() => applyRetrievalProfileMigration({
      ...input,
      expectedDigest: preview.before_digest,
      expectedCanaryDigest: preview.prerequisite_canary_receipt!.receipt_digest,
    })).toThrow(/changed after preview/);
  });

  it("requires phase 3 to name the complete remaining cohort from a phase 2 restart receipt", () => {
    const { dataDir } = fixture();
    enablePhaseOne(dataDir);
    const phaseOneCanary = writeCanaryReceipt({ dataDir, phase: 1, canaryBotIds: { qwen: "bot-ada" } });
    const phaseTwoInput = {
      dataDir,
      botIds: ["bot-same-name", "bot-codex"],
      profile: "task-scoped" as const,
      canaryPhase: 2 as const,
      sourceVersion: SOURCE_VERSION,
      sourceSha: SOURCE_SHA,
      canaryReceiptPath: phaseOneCanary.path,
    };
    const phaseTwoPreview = previewRetrievalProfileMigration(phaseTwoInput);
    applyRetrievalProfileMigration({
      ...phaseTwoInput,
      expectedDigest: phaseTwoPreview.before_digest,
      expectedCanaryDigest: phaseTwoPreview.prerequisite_canary_receipt!.receipt_digest,
    });
    const phaseTwoCanary = writeCanaryReceipt({
      dataDir,
      phase: 2,
      canaryBotIds: { qwen: "bot-ada", claude: "bot-same-name", codex: "bot-codex" },
    });
    expect(() => previewRetrievalProfileMigration({
      dataDir,
      botIds: ["bot-claude-two"],
      profile: "task-scoped",
      canaryPhase: 3,
      sourceVersion: SOURCE_VERSION,
      sourceSha: SOURCE_SHA,
      canaryReceiptPath: phaseTwoCanary.path,
    })).toThrow(/every remaining non-canary bot id/);
  });

  it("allows retrieval to be disabled independently of canary sequencing", () => {
    const { dataDir } = fixture();
    enablePhaseOne(dataDir);
    const input = { dataDir, botIds: ["bot-ada"], profile: "off" as const };
    const preview = previewRetrievalProfileMigration(input);
    expect(preview).toMatchObject({
      canary_phase: null,
      source_version: null,
      source_sha: null,
      prerequisite_canary_receipt: null,
      changed_bot_ids: ["bot-ada"],
    });
    const receipt = applyRetrievalProfileMigration({ ...input, expectedDigest: preview.before_digest });
    expect(receipt.applied).toBe(true);
  });

  it("restores exact original bot bytes from the receipt-bound backup without touching messages", () => {
    const { dataDir, botsPath, original } = fixture();
    const messagesPath = join(dataDir, "messages.db");
    writeFileSync(messagesPath, "MESSAGE DATABASE SENTINEL");
    const input = phaseOne(dataDir);
    const preview = previewRetrievalProfileMigration(input);
    const applied = applyRetrievalProfileMigration({
      ...input,
      expectedDigest: preview.before_digest,
      now: new Date("2026-08-22T06:00:00Z"),
    });
    const rollback = rollbackRetrievalProfileMigration({
      receiptPath: applied.receipt_path!,
      now: new Date("2026-08-22T08:00:00Z"),
    });

    expect(readFileSync(botsPath, "utf8")).toBe(original);
    expect(readFileSync(messagesPath, "utf8")).toBe("MESSAGE DATABASE SENTINEL");
    expect(rollback).toMatchObject({
      schema: "openmaus.retrieval-profile-rollback-receipt.v1",
      before_digest: preview.before_digest,
      restored_digest: preview.before_digest,
      rolled_back_at: "2026-08-22T08:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(rollback.rollback_receipt_path, "utf8"))).toEqual(rollback);
  });

  it("refuses rollback after bot-state drift and leaves both state and backup unchanged", () => {
    const { dataDir, botsPath, original } = fixture();
    const input = phaseOne(dataDir);
    const preview = previewRetrievalProfileMigration(input);
    const applied = applyRetrievalProfileMigration({
      ...input,
      expectedDigest: preview.before_digest,
      now: new Date("2026-08-22T06:30:00Z"),
    });
    const drift = `${readFileSync(botsPath, "utf8")}\n`;
    writeFileSync(botsPath, drift);

    expect(() => rollbackRetrievalProfileMigration({ receiptPath: applied.receipt_path! })).toThrow(/drifted after migration/);
    expect(readFileSync(botsPath, "utf8")).toBe(drift);
    expect(readFileSync(applied.backup_path!, "utf8")).toBe(original);
  });

  it("refuses a copied receipt and backup outside the bound data-directory migration root", () => {
    const { dataDir, botsPath, original } = fixture();
    const input = phaseOne(dataDir);
    const preview = previewRetrievalProfileMigration(input);
    const applied = applyRetrievalProfileMigration({
      ...input,
      expectedDigest: preview.before_digest,
      now: new Date("2026-08-22T09:00:00Z"),
    });
    const outside = mkdtempSync(join(tmpdir(), "openmaus-profile-forged-receipt-"));
    const outsideBackup = join(outside, "bots.json.original");
    const outsideReceipt = join(outside, "receipt.json");
    writeFileSync(outsideBackup, original);
    const forged = JSON.parse(readFileSync(applied.receipt_path!, "utf8"));
    forged.backup_path = outsideBackup;
    forged.receipt_path = outsideReceipt;
    writeFileSync(outsideReceipt, JSON.stringify(forged));
    const beforeAttempt = readFileSync(botsPath, "utf8");

    expect(() => rollbackRetrievalProfileMigration({ receiptPath: outsideReceipt }))
      .toThrow(/outside its data-directory migration root/);
    expect(readFileSync(botsPath, "utf8")).toBe(beforeAttempt);
    expect(readFileSync(outsideBackup, "utf8")).toBe(original);
  });
});
