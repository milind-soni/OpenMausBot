import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const ROOT = process.cwd();
const CLI = join(ROOT, "scripts", "import-centipede-profile.ts");
const FIXTURE = join(ROOT, "server", "test-support", "fixtures", "legacy-profile-generic.json");
const SCRATCH = process.env.OMB_PROFILE_IMPORT_PROOF_BASE
  ? resolve(ROOT, process.env.OMB_PROFILE_IMPORT_PROOF_BASE)
  : join(ROOT, "artifacts", "centipede-0.2.0", "importer", ".scratch");
const directories: string[] = [];

const commandResultSchema = z.object({
  status: z.enum(["dry-run", "applied", "unchanged"]),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  profileId: z.string(),
  accounts: z.number().int().nonnegative(),
  liveLocks: z.number().int().nonnegative(),
  accountIdentities: z.array(z.string()),
  workExternalIds: z.array(z.string()),
  postconditions: z.object({
    accounts: z.number().int().nonnegative(),
    work: z.number().int().nonnegative(),
    pendingApprovals: z.number().int().nonnegative(),
    deadlines: z.number().int().nonnegative(),
    actionRules: z.number().int().nonnegative(),
    actionRuleCandidates: z.number().int().nonnegative(),
  }).optional(),
}).strict();

const editableFixtureSchema = z.object({
  format: z.string(),
  version: z.number(),
  profile: z.object({
    accounts: z.array(z.record(z.string(), z.unknown())),
    liveLocks: z.array(z.record(z.string(), z.unknown())),
  }).passthrough(),
}).passthrough();

interface ProfileProofTrace {
  syntheticRoot: string;
  targetRoot: string;
  sourceFixture: string;
  planHash: string;
  canonicalTreeHash: string;
  postconditions: NonNullable<z.infer<typeof commandResultSchema>["postconditions"]>;
  targetRemovedByCleanup: true;
}

function scratchRoot(label: string): string {
  mkdirSync(SCRATCH, { recursive: true });
  const directory = mkdtempSync(join(SCRATCH, `${label}-`));
  directories.push(directory);
  return directory;
}

function invoke(args: readonly string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
}

function successfulJson(result: ReturnType<typeof invoke>): z.infer<typeof commandResultSchema> {
  expect(result.status, result.stderr).toBe(0);
  return commandResultSchema.parse(JSON.parse(result.stdout));
}

function treeHash(root: string): string {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

function editableFixture(): z.infer<typeof editableFixtureSchema> {
  return editableFixtureSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));
}

function traceProof(value: ProfileProofTrace): void {
  if (process.env.OMB_PROFILE_IMPORT_DRILL_TRACE === "1") {
    process.stdout.write(`[profile-import-proof] ${JSON.stringify(value)}\n`);
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("generic legacy profile import command", () => {
  it("requires a reviewed dry-run hash, applies once, and verifies exact canonical state after restart", () => {
    const root = scratchRoot("journey");
    const target = join(root, "canonical-data");

    const dryRun = successfulJson(invoke(["--source", FIXTURE, "--target", target, "--dry-run"]));
    expect(dryRun).toMatchObject({
      status: "dry-run",
      profileId: "northstar-field-ops",
      accounts: 2,
      liveLocks: 2,
      accountIdentities: ["Field Notes", "Operations Vault"],
      workExternalIds: ["lock:sensor-calibration", "lock:specimen-ledger"],
    });
    expect(existsSync(target)).toBe(false);

    const applied = successfulJson(invoke([
      "--source", FIXTURE,
      "--target", target,
      "--apply",
      "--plan-hash", dryRun.planHash,
    ]));
    expect(applied).toMatchObject({
      status: "applied",
      planHash: dryRun.planHash,
      postconditions: {
        accounts: 2,
        work: 2,
        pendingApprovals: 1,
        deadlines: 1,
        actionRules: 0,
        actionRuleCandidates: 0,
      },
    });
    const beforeReplay = treeHash(target);

    // A second process constructs fresh store and orchestrator instances.
    const replay = successfulJson(invoke([
      "--source", FIXTURE,
      "--target", target,
      "--apply",
      "--plan-hash", dryRun.planHash,
    ]));
    expect(replay).toMatchObject({ status: "unchanged", postconditions: applied.postconditions });
    expect(treeHash(target)).toBe(beforeReplay);
    if (!replay.postconditions) throw new Error("Applied profile result did not include postconditions");
    traceProof({
      syntheticRoot: relative(ROOT, root).replaceAll("\\", "/"),
      targetRoot: relative(ROOT, target).replaceAll("\\", "/"),
      sourceFixture: relative(ROOT, FIXTURE).replaceAll("\\", "/"),
      planHash: dryRun.planHash,
      canonicalTreeHash: beforeReplay,
      postconditions: replay.postconditions,
      targetRemovedByCleanup: true,
    });
  });

  it("refuses changed replay content without mutating the completed target", () => {
    const root = scratchRoot("changed-replay");
    const target = join(root, "canonical-data");
    const initialPlan = successfulJson(invoke(["--source", FIXTURE, "--target", target, "--dry-run"]));
    successfulJson(invoke(["--source", FIXTURE, "--target", target, "--apply", "--plan-hash", initialPlan.planHash]));
    const before = treeHash(target);

    const changedSource = join(root, "changed-profile.json");
    const changedText = readFileSync(FIXTURE, "utf8").replace(
      "Reconcile specimen ledger",
      "Reconcile specimen archive",
    );
    writeFileSync(changedSource, changedText, "utf8");
    const changedPlan = successfulJson(invoke(["--source", changedSource, "--target", target, "--dry-run"]));
    expect(changedPlan.planHash).not.toBe(initialPlan.planHash);
    const changedApply = invoke([
      "--source", changedSource,
      "--target", target,
      "--apply",
      "--plan-hash", changedPlan.planHash,
    ]);
    expect(changedApply.status).not.toBe(0);
    expect(changedApply.stderr).toContain("different content");
    expect(treeHash(target)).toBe(before);
  });

  it("fails closed on ambiguity, duplicate work, forbidden fields, and partial target state", () => {
    const root = scratchRoot("fail-closed");
    const fixture = editableFixture();

    const ambiguousSource = join(root, "ambiguous.json");
    const firstAccount = fixture.profile.accounts[0];
    expect(firstAccount).toBeDefined();
    writeFileSync(ambiguousSource, JSON.stringify({
      ...fixture,
      profile: {
        ...fixture.profile,
        accounts: [...fixture.profile.accounts, { ...firstAccount, accountId: "ca_papertrail_99", sourceId: "legacy-profile:northstar:ambiguous" }],
      },
    }), "utf8");
    const ambiguous = invoke(["--source", ambiguousSource, "--target", join(root, "ambiguous-target"), "--dry-run"]);
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain("ambiguous");

    const duplicateSource = join(root, "duplicate-work.json");
    const firstWork = fixture.profile.liveLocks[0];
    expect(firstWork).toBeDefined();
    writeFileSync(duplicateSource, JSON.stringify({
      ...fixture,
      profile: { ...fixture.profile, liveLocks: [...fixture.profile.liveLocks, { ...firstWork, title: "Conflicting duplicate" }] },
    }), "utf8");
    const duplicate = invoke(["--source", duplicateSource, "--target", join(root, "duplicate-target"), "--dry-run"]);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("duplicate work identity");

    const forbiddenSource = join(root, "forbidden.json");
    writeFileSync(forbiddenSource, JSON.stringify({
      ...fixture,
      profile: { ...fixture.profile, authority: { autoApprove: true } },
    }), "utf8");
    const forbidden = invoke(["--source", forbiddenSource, "--target", join(root, "forbidden-target"), "--dry-run"]);
    expect(forbidden.status).not.toBe(0);
    expect(forbidden.stderr).toContain("invalid legacy profile");

    const partialTarget = join(root, "partial-target");
    mkdirSync(partialTarget);
    const marker = join(partialTarget, "unrelated.txt");
    writeFileSync(marker, "preserve me", "utf8");
    const plan = successfulJson(invoke(["--source", FIXTURE, "--target", partialTarget, "--dry-run"]));
    const partial = invoke(["--source", FIXTURE, "--target", partialTarget, "--apply", "--plan-hash", plan.planHash]);
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain("incomplete target");
    expect(readFileSync(marker, "utf8")).toBe("preserve me");
    expect(statSync(partialTarget).isDirectory()).toBe(true);
  });

  it("refuses a completed target with a missing journal and does not synthesize replacement work", () => {
    const root = scratchRoot("missing-journal");
    const target = join(root, "canonical-data");
    const plan = successfulJson(invoke(["--source", FIXTURE, "--target", target, "--dry-run"]));
    successfulJson(invoke(["--source", FIXTURE, "--target", target, "--apply", "--plan-hash", plan.planHash]));
    const journalFile = join(target, "work-orchestrator.json");
    const journal = readFileSync(journalFile, "utf8");
    writeFileSync(journalFile, "{\"version\":1,\"entries\":", "utf8");

    const refused = invoke(["--source", FIXTURE, "--target", target, "--apply", "--plan-hash", plan.planHash]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("work replay failed");

    writeFileSync(journalFile, journal, "utf8");
    const recovered = successfulJson(invoke([
      "--source", FIXTURE,
      "--target", target,
      "--apply",
      "--plan-hash", plan.planHash,
    ]));
    expect(recovered).toMatchObject({ status: "unchanged", postconditions: { work: 2 } });
  });
});
