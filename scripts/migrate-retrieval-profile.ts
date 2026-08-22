import { resolve } from "node:path";

import { retrievalProfileSchema } from "../shared/retrieval-profile.ts";
import {
  applyRetrievalProfileMigration,
  previewRetrievalProfileMigration,
  rollbackRetrievalProfileMigration,
  type RetrievalCanaryPhase,
} from "../server/retrieval-profile-migration.ts";

function values(argv: string[], flag: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1]) found.push(argv[index + 1]!);
  }
  return found;
}

function value(argv: string[], flag: string): string | undefined {
  return values(argv, flag).at(-1);
}

const argv = process.argv.slice(2);
const dataDir = value(argv, "--data-dir");
const botIds = values(argv, "--bot-id");
const profile = value(argv, "--profile");
const expectedDigest = value(argv, "--expected-digest");
const phaseValue = value(argv, "--phase");
const sourceVersion = value(argv, "--source-version");
const sourceSha = value(argv, "--source-sha");
const canaryReceipt = value(argv, "--canary-receipt");
const expectedCanaryDigest = value(argv, "--expected-canary-digest");
const apply = argv.includes("--apply");
const rollback = value(argv, "--rollback");

if (rollback) {
  if (apply || dataDir || botIds.length || profile || expectedDigest || phaseValue || sourceVersion || sourceSha
    || canaryReceipt || expectedCanaryDigest) {
    throw new Error("--rollback <canonical receipt> is mutually exclusive with preview and apply arguments");
  }
  process.stdout.write(`${JSON.stringify(rollbackRetrievalProfileMigration({ receiptPath: resolve(rollback) }), null, 2)}\n`);
} else {
  const parsedProfile = retrievalProfileSchema.safeParse(profile);
  const parsedPhase = phaseValue === undefined ? undefined : Number(phaseValue);
  const canaryPhase: RetrievalCanaryPhase | undefined =
    parsedPhase === 1 || parsedPhase === 2 || parsedPhase === 3 ? parsedPhase : undefined;
  if (!dataDir || !botIds.length || !parsedProfile.success) {
    throw new Error(
      "usage: migrate-retrieval-profile.ts --data-dir <stopped data dir> --bot-id <exact id> [--bot-id <id>] --profile off [--apply --expected-digest <sha256>] | --profile task-scoped --phase <1|2|3> --source-version <semver> --source-sha <full sha> [--canary-receipt <prior restart receipt>] [--apply --expected-digest <sha256> --expected-canary-digest <sha256>] | --rollback <canonical receipt>",
    );
  }
  if (phaseValue !== undefined && canaryPhase === undefined) throw new Error("--phase must be 1, 2, or 3");

  const input = {
    dataDir: resolve(dataDir),
    botIds,
    profile: parsedProfile.data,
    canaryPhase,
    sourceVersion,
    sourceSha,
    canaryReceiptPath: canaryReceipt ? resolve(canaryReceipt) : undefined,
  };
  if (!apply) {
    process.stdout.write(`${JSON.stringify(previewRetrievalProfileMigration(input), null, 2)}\n`);
  } else {
    if (!expectedDigest) throw new Error("--apply requires the exact --expected-digest from preview");
    process.stdout.write(`${JSON.stringify(applyRetrievalProfileMigration({
      ...input,
      expectedDigest,
      expectedCanaryDigest,
    }), null, 2)}\n`);
  }
}
