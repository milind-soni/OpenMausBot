import { z } from "zod";
import { secretName } from "./skill-secret-names.ts";

export const SKILL_BUNDLE_MAX_FILES = 32, SKILL_BUNDLE_FILE_MAX_BYTES = 64 * 1024, SKILL_BUNDLE_MAX_BYTES = 512 * 1024;
export const SKILL_FOLDER_MAX_FILES = 128, SKILL_FOLDER_FILE_MAX_BYTES = 512 * 1024, SKILL_FOLDER_MAX_BYTES = 2 * 1024 * 1024;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
// An unpaired surrogate is replaced during UTF-8 encoding, so it cannot round-trip to disk.
export const isUtf8Text = (text: string) => {
  if (text.includes("\0")) return false;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
};

/** Portable companion paths must be relative and safe on each supported platform. */
export function isPortableFolderPath(path: string): boolean {
  const parts = path.split("/");
  return isUtf8Text(path) && utf8Bytes(path) <= 512 && parts.length <= 8 &&
    parts.every((part) => !!part && !secretName(part) && !part.startsWith(".") && !/[. ]$/.test(part) &&
      ![...part].some((char) => char < " " || char === "\u007f" || '<>:"|?*\\'.includes(char)) && utf8Bytes(part) <= 255 &&
      !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i.test(part) &&
      !["node_modules", "__pycache__", "venv"].includes(part.toLowerCase())) &&
    parts[0]!.toLowerCase() !== "skill.md" && parts.at(-1)!.toLowerCase() !== "skill.md";
}

export function isPortableSkillPath(path: string): boolean {
  return /\.md$/i.test(path) && isPortableFolderPath(path);
}

const skillCompanionSchema = z.object({
  path: z.string().refine(isPortableSkillPath, "must be a safe relative Markdown path"),
  content: z.string().refine((text) => isUtf8Text(text) && utf8Bytes(text) <= SKILL_BUNDLE_FILE_MAX_BYTES, "must be bounded UTF-8 text"),
}).strict();

function pathsCollide(files: ReadonlyArray<{ path: string }>): boolean {
  const held = new Map<string, { spelling: string; folder: boolean }>();
  for (const { path } of files) {
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const prefix = parts.slice(0, index + 1).join("/");
      const key = prefix.normalize("NFC").toLowerCase();
      const existing = held.get(key);
      if (existing && (index === parts.length - 1 || !existing.folder || existing.spelling !== prefix)) return true;
      held.set(key, { spelling: prefix, folder: index < parts.length - 1 });
    }
  }
  return false;
}

export const skillCompanionsSchema = z.array(skillCompanionSchema).min(1).max(SKILL_BUNDLE_MAX_FILES).superRefine((files, ctx) => {
  if (files.reduce((total, file) => total + utf8Bytes(file.content), 0) > SKILL_BUNDLE_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: "skill files are too large" });
  }
  if (pathsCollide(files)) {
    ctx.addIssue({ code: "custom", message: "skill file paths must not collide" });
  }
});

const canonicalBase64 = (value: string): boolean => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  try { return btoa(atob(value)) === value; } catch { return false; }
};
const opaqueBytes = (value: string): boolean => {
  try {
    const raw = atob(value);
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    return !isUtf8Text(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch { return true; }
};
export const skillBinaryLength = (value: string): number => value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
const folderTextFileSchema = z.object({
  path: z.string().refine(isPortableFolderPath, "must be a safe relative path"),
  content: z.string().refine((text) => isUtf8Text(text) && utf8Bytes(text) <= SKILL_FOLDER_FILE_MAX_BYTES, "must be bounded UTF-8 text"),
  executable: z.literal(true).optional(),
}).strict();
const folderBinaryFileSchema = z.object({
  path: z.string().refine(isPortableFolderPath, "must be a safe relative path"),
  binary: z.object({ base64: z.string().max(Math.ceil(SKILL_FOLDER_FILE_MAX_BYTES / 3) * 4)
    .refine(canonicalBase64, "must be canonical base64").refine(opaqueBytes, "must contain opaque bytes") }).strict(),
}).strict();

/** Version 3 keeps opaque bytes separate from text, which is scanned and redacted. */
export const portableFolderFilesSchema = z.array(z.union([folderTextFileSchema, folderBinaryFileSchema])).min(1).max(SKILL_FOLDER_MAX_FILES)
  .superRefine((files, ctx) => {
    const sizes = files.map((file) => "content" in file ? utf8Bytes(file.content) : skillBinaryLength(file.binary.base64));
    if (sizes.some((size) => size > SKILL_FOLDER_FILE_MAX_BYTES) || sizes.reduce((total, size) => total + size, 0) > SKILL_FOLDER_MAX_BYTES) {
      ctx.addIssue({ code: "custom", message: "skill files are too large" });
    }
    if (pathsCollide(files)) {
      ctx.addIssue({ code: "custom", message: "skill file paths must not collide" });
    }
  });
export type PortableFolderFile = z.output<typeof portableFolderFilesSchema>[number];
