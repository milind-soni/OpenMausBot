// A project's own standing instructions (Phase 1 part 3, gap analysis §17):
// `AGENTS.md` in the task's working folder is the per-project channel for
// every engine. Codex reads the file itself and Claude Code reads CLAUDE.md
// itself; pi, the ACP family, the HTTP family and the box agent read
// neither, so the harness hands them the same text as a stable prompt
// section — and hands it to Claude too, whose native read covers CLAUDE.md
// only. Stable per folder: a folder change is a thread change, never a
// mid-thread prompt change.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { redactSecretsInText } from "./redact.ts";

export const PROJECT_INSTRUCTIONS_FILE = "AGENTS.md";
export const PROJECT_INSTRUCTIONS_MAX_BYTES = 16 * 1024;

/** Engines that read AGENTS.md natively; the harness must not hand it to
 * them a second time, where the copy would outrank the original. */
export const READS_AGENTS_MD_NATIVELY: ReadonlySet<string> = new Set(["codex"]);

export interface ProjectInstructions {
  path: string;
  text: string;
  bytes: number;
  truncated: boolean;
}

/** The folder's AGENTS.md, redacted, capped; null when there is none or it
 * cannot be read. Never throws: a missing project file is an absent section. */
export function readProjectInstructions(cwd: string | undefined): ProjectInstructions | null {
  if (!cwd) return null;
  const path = join(cwd, PROJECT_INSTRUCTIONS_FILE);
  try {
    if (!statSync(path).isFile()) return null;
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return null;
    const bytes = Buffer.byteLength(raw, "utf8");
    let text = raw;
    let truncated = false;
    if (bytes > PROJECT_INSTRUCTIONS_MAX_BYTES) {
      text = Buffer.from(raw, "utf8").subarray(0, PROJECT_INSTRUCTIONS_MAX_BYTES).toString("utf8").replace(/�+$/, "");
      truncated = true;
    }
    return { path, text: redactSecretsInText(text), bytes, truncated };
  } catch {
    return null;
  }
}

/** The prompt section, or "" for an engine that reads the file itself. */
export function projectInstructionsPrompt(cwd: string | undefined, driverKind: string | undefined): string {
  if (driverKind && READS_AGENTS_MD_NATIVELY.has(driverKind)) return "";
  const found = readProjectInstructions(cwd);
  if (!found) return "";
  return (
    `\n\nStanding instructions from the project's ${PROJECT_INSTRUCTIONS_FILE} (${JSON.stringify(found.path)}); a person wrote them for whoever works in this folder, and they apply to your work here:\n` +
    found.text.trimEnd() +
    (found.truncated ? `\n[${PROJECT_INSTRUCTIONS_FILE} is ${found.bytes} bytes; only the first ${PROJECT_INSTRUCTIONS_MAX_BYTES} are shown.]` : "")
  );
}
