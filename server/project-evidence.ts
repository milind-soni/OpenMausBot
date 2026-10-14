import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { redactSecretsInText } from "./redact.ts";
import { canonicalJson } from "../shared/package-format.ts";
import type { EvidenceFile, EvidenceStatus, ProjectEvidence } from "../shared/project-evidence.ts";

const fileSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number(), modified: z.number(), changed: z.number(), inode: z.number() });
export const projectEvidenceSchema = z.object({ root: z.string(), project: fileSchema, artifacts: z.array(fileSchema).min(1).max(4),
  recordedAt: z.number(), stage: z.enum(["rendered", "checked"]), check: z.string().max(600), approval: z.object({ at: z.number(), revision: z.string(), by: z.string().default("owner") }).optional() });
export const evidenceInputSchema = z.object({ project: z.string().min(1).max(1024), artifacts: z.array(z.string().min(1).max(1024)).min(1).max(4),
  stage: z.enum(["rendered", "checked"]), check: z.string().min(1).max(600) }).strict();
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

function scopedPath(root: string, path: string): string {
  const target = realpathSync(resolve(root, path));
  const local = relative(root, target);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error("Evidence must be a file inside this conversation's working folder");
  return target;
}

async function snapshot(root: string, path: string): Promise<EvidenceFile> {
  const target = scopedPath(root, path);
  const handle = await open(target, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error("Use an evidence file smaller than 512 MiB (for video, a short preview)");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      if (position > MAX_FILE_BYTES) throw new Error("Evidence grew beyond the size limit");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || scopedPath(root, path) !== target || statSync(target).ino !== after.ino) throw new Error("Evidence changed while being recorded; retry after saving");
    return { path: relative(root, target), sha256: hash.digest("hex"), bytes: after.size, modified: after.mtimeMs, changed: after.ctimeMs, inode: after.ino };
  } finally { await handle.close(); }
}

export async function recordProjectEvidence(folder: string, input: EvidenceInput): Promise<ProjectEvidence> {
  const root = realpathSync(folder);
  const project = await snapshot(root, input.project);
  const artifacts: EvidenceFile[] = [];
  for (const path of new Set(input.artifacts)) artifacts.push(await snapshot(root, path));
  const evidence: ProjectEvidence = { root, project, artifacts, stage: input.stage, check: redactSecretsInText(input.check), recordedAt: Date.now() };
  if (projectEvidenceStatus(evidence) === "stale") throw new Error("Project changed while recording evidence; retry after saving");
  return evidence;
}

export function evidenceRevision(evidence: ProjectEvidence): string {
  return createHash("sha256").update(canonicalJson([evidence.root, evidence.project, evidence.artifacts, evidence.stage, evidence.check])).digest("hex");
}

export function projectEvidenceStatus(evidence: ProjectEvidence): EvidenceStatus {
  try {
    for (const file of [evidence.project, ...evidence.artifacts]) {
      const stat = statSync(scopedPath(evidence.root, file.path));
      if (!stat.isFile() || stat.size !== file.bytes || stat.mtimeMs !== file.modified || stat.ctimeMs !== file.changed || stat.ino !== file.inode) return "stale";
    }
  } catch { return "stale"; }
  if (evidence.approval?.revision === evidenceRevision(evidence)) return "approved";
  return evidence.stage === "checked" ? "agent-checked" : "recorded";
}

export async function verifyProjectEvidence(evidence: ProjectEvidence): Promise<boolean> {
  if (projectEvidenceStatus(evidence) === "stale") return false;
  try {
    for (const file of [evidence.project, ...evidence.artifacts]) {
      if ((await snapshot(evidence.root, file.path)).sha256 !== file.sha256) return false;
    }
    return projectEvidenceStatus(evidence) !== "stale";
  } catch { return false; }
}

/** Read only a recorded artifact, never a client-supplied path. */
export async function openEvidenceArtifact(evidence: ProjectEvidence, index: number) {
  const file = evidence.artifacts[index];
  if (!file) throw new Error("Evidence is missing");
  const target = scopedPath(evidence.root, file.path);
  const handle = await open(target, "r");
  try {
    const stat = await handle.stat();
    if (stat.size !== file.bytes || stat.mtimeMs !== file.modified || stat.ctimeMs !== file.changed || stat.ino !== file.inode) throw new Error("Evidence changed before opening");
    return { handle, bytes: file.bytes, name: file.path.split(/[\\/]/).pop() ?? "evidence" };
  } catch (error) { await handle.close(); throw error; }
}
