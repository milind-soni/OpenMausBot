// The files beside a skill's SKILL.md that travel in a template: its scripts, references and small text assets, as
// skills/<name>/<path> in the folder and `files` on the package's skill entry. Pure (no node:*): the folder reader, the
// writer and the package gate apply the same rules, on the server, in the renderer and at the Admin.
// Security: plain relative paths only (nothing hidden, no generated folders, nothing a skill folder can't hold), text
// only, size-capped, and never a file named like a credential store or holding a credential's shape. Their text is not
// passed through redactSecretsInText, which would rewrite ordinary code (`token = os.environ[...]`): a credential in
// one refuses that file instead.
import { z } from "zod";

import { holdsCredential, scrubHeldSecrets } from "./redact.ts";

/** Per skill: how many files beside SKILL.md, the bytes of each and of all together, and how deep a path may go. */
export const SKILL_FILE_LIMITS = { files: 30, fileBytes: 128 * 1024, bytes: 512 * 1024, depth: 6, segmentBytes: 120 } as const;

export type SkillFileRefusal = "name" | "hidden" | "generated" | "deep" | "secret_name" | "binary" | "large" | "secret" | "duplicate" | "full";

export interface SkillFile {
  /** Relative to the skill's folder, "/"-separated. */
  path: string;
  content: string;
}

const GENERATED = new Set(["node_modules", "__pycache__", "venv"]);
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
const SECRET_NAME = /^(?:.+\.(?:env|pem|key|p12|pfx|keystore|jks|kdbx|ppk|gpg|asc|crt|cer|der)|env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.+[-_.]secrets?\.[a-z]+|tokens?\.(?:json|txt|ya?ml)|auth\.json|service[-_]?account.*\.json|netrc|npmrc|pypirc)$/i;
const encoder = new TextEncoder();
const bytesOf = (text: string) => encoder.encode(text).length;
const unsafeCharacter = (char: string) => char < " " || char === "\u007f" || '<>:"|?*\\'.includes(char);

/** Why `path` can't be a file beside SKILL.md, by its name alone; null when it can. At least as strict as the rule a
 * skill folder is stored by, so whatever passes here is stored whole when it is added. */
export function skillFilePathProblem(path: string): SkillFileRefusal | null {
  if (!path || path.length > 300) return "name";
  const parts = path.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || [...part].some(unsafeCharacter) || /[. ]$/.test(part) ||
      WINDOWS_DEVICE.test(part) || bytesOf(part) > SKILL_FILE_LIMITS.segmentBytes) return "name";
    if (part.startsWith(".")) return "hidden";
    if (GENERATED.has(part.toLowerCase())) return "generated";
    if (part.toLowerCase() === "skill.md") return "name";
  }
  if (parts.length > SKILL_FILE_LIMITS.depth) return "deep";
  return SECRET_NAME.test(parts.at(-1)!) ? "secret_name" : null;
}

const strictText = new TextDecoder("utf-8", { fatal: true });

/** The file's text, or null for one that is not UTF-8 text (a picture, an archive, a compiled file). */
export function skillFileText(content: string | Uint8Array): string | null {
  let text: string;
  if (typeof content === "string") text = content;
  else {
    try {
      text = strictText.decode(content);
    } catch {
      return null;
    }
  }
  return text.includes("\u0000") || text.includes("�") ? null : text;
}

/** Why one file can't travel; null when it can. */
export function skillFileProblem(path: string, content: string | Uint8Array): SkillFileRefusal | null {
  const named = skillFilePathProblem(path);
  if (named) return named;
  const text = skillFileText(content);
  if (text === null) return "binary";
  if (bytesOf(text) > SKILL_FILE_LIMITS.fileBytes) return "large";
  return holdsCredential(text) || scrubHeldSecrets(text) !== text ? "secret" : null;
}

const WORDS: Record<SkillFileRefusal, string> = {
  name: "has a name a skill folder can't hold",
  hidden: "is hidden",
  generated: "is in a generated folder",
  deep: "is too deep in folders",
  secret_name: "is named like a key or password file",
  binary: "isn't a text file",
  large: `is larger than ${SKILL_FILE_LIMITS.fileBytes / 1024} KB`,
  secret: "looks like it holds a key or password",
  duplicate: "has the same name as another file",
  full: "is past the skill's file limit",
};
export const skillFileRefusalWords = (reason: SkillFileRefusal): string => WORDS[reason];

/** What of a skill's files can travel, shallow files first, within SKILL_FILE_LIMITS; the rest with why. */
export function admitSkillFiles(files: ReadonlyArray<{ path: string; content: string | Uint8Array }>): {
  files: SkillFile[];
  refused: Array<{ path: string; reason: SkillFileRefusal }>;
} {
  const ordered = [...files].sort((a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const kept: SkillFile[] = [];
  const refused: Array<{ path: string; reason: SkillFileRefusal }> = [];
  const held = new Set<string>();
  let total = 0;
  for (const file of ordered) {
    const problem = skillFileProblem(file.path, file.content);
    if (problem) {
      refused.push({ path: file.path, reason: problem });
      continue;
    }
    const text = skillFileText(file.content)!;
    const size = bytesOf(text);
    const key = file.path.normalize("NFC").toLowerCase();
    if (held.has(key)) refused.push({ path: file.path, reason: "duplicate" });
    else if (kept.length >= SKILL_FILE_LIMITS.files || total + size > SKILL_FILE_LIMITS.bytes) refused.push({ path: file.path, reason: "full" });
    else {
      held.add(key);
      kept.push({ path: file.path, content: text });
      total += size;
    }
  }
  return { files: kept, refused };
}

/** A skill entry's `files` in the package gate: every file must pass, as admitSkillFiles would keep it. */
export const skillFilesSchema = z
  .array(z.object({ path: z.string({ error: "must be text" }), content: z.string({ error: "must be text" }) }))
  .max(SKILL_FILE_LIMITS.files, { message: `must have at most ${SKILL_FILE_LIMITS.files} files` })
  .superRefine((files, ctx) => {
    const { refused } = admitSkillFiles(files);
    for (const { path, reason } of refused) ctx.addIssue({ code: "custom", message: `${path.slice(0, 120)} ${skillFileRefusalWords(reason)}` });
  })
  .optional();
