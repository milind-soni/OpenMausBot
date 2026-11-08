import { z } from "zod";

export const SKILL_BUNDLE_MAX_FILES = 32, SKILL_BUNDLE_FILE_MAX_BYTES = 64 * 1024, SKILL_BUNDLE_MAX_BYTES = 512 * 1024;
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

/** Portable Markdown companions use relative paths that are safe on each supported platform. */
export function isPortableSkillPath(path: string): boolean {
  const parts = path.split("/");
  return isUtf8Text(path) && utf8Bytes(path) <= 512 && parts.length <= 8 && /\.md$/i.test(path) &&
    parts.every((part) => !!part && !part.startsWith(".") && !/[. ]$/.test(part) &&
      ![...part].some((char) => char < " " || char === "\u007f" || '<>:"|?*\\'.includes(char)) && utf8Bytes(part) <= 255 &&
      !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i.test(part) &&
      !["node_modules", "__pycache__", "venv"].includes(part.toLowerCase())) &&
    parts.at(-1)!.toLowerCase() !== "skill.md";
}

const skillCompanionSchema = z.object({
  path: z.string().refine(isPortableSkillPath, "must be a safe relative Markdown path"),
  content: z.string().refine((text) => isUtf8Text(text) && utf8Bytes(text) <= SKILL_BUNDLE_FILE_MAX_BYTES, "must be bounded UTF-8 text"),
}).strict();
export const skillCompanionsSchema = z.array(skillCompanionSchema).min(1).max(SKILL_BUNDLE_MAX_FILES).superRefine((files, ctx) => {
  if (files.reduce((total, file) => total + utf8Bytes(file.content), 0) > SKILL_BUNDLE_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: "skill files are too large" });
  }
  const paths = files.map((file) => file.path.normalize("NFC").toLowerCase()).sort();
  if (paths.some((path, index) => index > 0 && (path === paths[index - 1] || path.startsWith(`${paths[index - 1]}/`)))) {
    ctx.addIssue({ code: "custom", message: "skill file paths must not collide" });
  }
});
