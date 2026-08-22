import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { agentGraphNoFollowFlag } from "./agent-graph-evidence.ts";
import { AnchoredFileError, writeAnchoredFileSync } from "./anchored-file.ts";
import type { AgentGraphRunReceipt } from "./agent-graphs.ts";
import { redactSecretsInText } from "./redact.ts";

export const IMPROVEMENT_OBSERVATION_SCHEMA = "improvement_observation.v1" as const;

function stableSingleLinkFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.isFile() && right.isFile() && left.nlink === 1 && right.nlink === 1 &&
    left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function writeVerifiedAgentGraphObservation(
  receipt: AgentGraphRunReceipt,
  options: { directory?: string; beforeAnchoredWrite?: () => void } = {},
): string | null {
  if (
    receipt.status !== "completed" || receipt.verification_status !== "verified" ||
    typeof receipt.verified_at !== "string" || !receipt.evidence_manifest_hash ||
    receipt.nodes.some((node) =>
      node.status !== "completed" || node.evidence_status !== "verified" || !node.verified_evidence.length)
  ) return null;
  const directory = options.directory ?? process.env.AOS_IMPROVEMENT_OBSERVATIONS_DIR ??
    join(homedir(), ".local", "state", "self-improve-recs", "observations");
  mkdirSync(directory, { recursive: true });
  const requestedDirectoryInfo = lstatSync(directory);
  if (!requestedDirectoryInfo.isDirectory() || requestedDirectoryInfo.isSymbolicLink()) {
    throw new Error("improvement observation directory must be a real directory");
  }
  const canonicalDirectory = realpathSync(directory);
  const directoryInfo = lstatSync(canonicalDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
      directoryInfo.dev !== requestedDirectoryInfo.dev || directoryInfo.ino !== requestedDirectoryInfo.ino) {
    throw new Error("improvement observation directory identity changed during canonicalization");
  }
  const receiptHash = `sha256:${createHash("sha256").update(JSON.stringify(receipt)).digest("hex")}`;
  const at = new Date(receipt.verified_at).toISOString();
  if (at !== receipt.verified_at) throw new Error("verified graph receipt timestamp is invalid");
  const identity = createHash("sha256").update(`${receipt.graph_id}:${receiptHash}`).digest("hex").slice(0, 32);
  const dedupeKey = `sha256:${createHash("sha256").update(JSON.stringify({
    graph_hash: receipt.graph_hash,
    proposal_ids: receipt.proposal_ids,
  })).digest("hex")}`;
  // The free-form objective may contain private project context. Observation
  // transport needs identity and proof hashes, not a copy of that prose.
  const rawSummary = `Verified OpenMaus agent graph ${receipt.graph_id} (${receipt.graph_hash})`;
  const sanitizedSummary = redactSecretsInText(rawSummary);
  if (sanitizedSummary !== rawSummary) return null;
  const summary = rawSummary.trim().slice(0, 500);
  if (!summary) return null;
  const observation = {
    schema: IMPROVEMENT_OBSERVATION_SCHEMA,
    observation_id: `observation-${identity}`,
    surface: "openmaus",
    project: "openmausbot",
    category: "verified_agent_graph",
    summary,
    evidence_refs: [...new Set([
      receipt.graph_hash,
      receiptHash,
      receipt.evidence_manifest_hash,
      ...receipt.nodes.flatMap((node) => node.proof_refs),
      ...receipt.nodes.flatMap((node) => node.verified_evidence.map((item) => item.sha256)),
    ])].slice(0, 12),
    dedupe_key: dedupeKey,
    sensitivity: "restricted",
    timestamp: at,
  };
  const path = join(canonicalDirectory, `${observation.observation_id}.json`);
  const serialized = JSON.stringify(observation, null, 2) + "\n";
  let fd: number | null = null;
  try {
    const written = writeAnchoredFileSync({
      path,
      parent: { dev: directoryInfo.dev, ino: directoryInfo.ino },
      mode: "create",
      content: serialized,
      maximumBytes: 2 * 1024 * 1024,
    }, { beforeSpawn: options.beforeAnchoredWrite });
    const pathAfter = lstatSync(path);
    const directoryAfter = lstatSync(canonicalDirectory);
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1 ||
        pathAfter.dev !== written.dev || pathAfter.ino !== written.ino ||
        pathAfter.size !== Buffer.byteLength(serialized, "utf8") || !directoryAfter.isDirectory() ||
        directoryAfter.isSymbolicLink() || directoryAfter.dev !== directoryInfo.dev || directoryAfter.ino !== directoryInfo.ino) {
      throw new Error("improvement observation path or directory changed while it was being written");
    }
    return path;
  } catch (error) {
    if (!(error instanceof AnchoredFileError) || error.code !== "EEXIST") throw error;
    const pathBefore = lstatSync(path);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1 ||
        pathBefore.size > 2 * 1024 * 1024) {
      throw new Error("existing improvement observation is not a bounded single-link regular file");
    }
    fd = openSync(path, fsConstants.O_RDONLY | agentGraphNoFollowFlag());
    const before = fstatSync(fd);
    if (!stableSingleLinkFile(pathBefore, before) || before.size > 2 * 1024 * 1024) {
      throw new Error("existing improvement observation changed before it was read");
    }
    const existing = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    const directoryAfter = lstatSync(canonicalDirectory);
    if (!stableSingleLinkFile(before, after) || !stableSingleLinkFile(after, pathAfter) ||
        Buffer.byteLength(existing, "utf8") !== after.size || !directoryAfter.isDirectory() ||
        directoryAfter.isSymbolicLink() || directoryAfter.dev !== directoryInfo.dev || directoryAfter.ino !== directoryInfo.ino) {
      throw new Error("existing improvement observation changed while it was being read");
    }
    if (existing === serialized) return null;
    throw new Error("deterministic improvement observation identity already contains different content");
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
