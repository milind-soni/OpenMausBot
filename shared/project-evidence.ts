/** Evidence describes saved files. It cannot certify unsaved editor state. */
export interface EvidenceFile {
  path: string;
  sha256: string;
  bytes: number;
  modified: number;
  changed: number;
  inode: number;
}

export interface ProjectEvidence {
  root: string;
  project: EvidenceFile;
  artifacts: EvidenceFile[];
  recordedAt: number;
  stage: "rendered" | "checked";
  check: string;
  approval?: { at: number; revision: string; by: string };
}

export type EvidenceStatus = "recorded" | "agent-checked" | "approved" | "stale";
