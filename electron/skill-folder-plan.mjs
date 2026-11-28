/** `depth` counts path segments, file name included. */
export const SKILL_FOLDER_LIMITS = { files: 200, bytes: 16 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, depth: 8 };
export const SKILL_IMPORT_SKIP_REPORT_MAX = 20;

const GENERATED = new Set(["__pycache__", "node_modules", "venv"]);
const unsafeCharacter = (char) => char < " " || char === "\u007f" || '<>:"|?*\\'.includes(char);
// Windows refuses these names in any folder, with or without an extension.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/** Why `path` (relative, "/"-separated) may not be written inside a skill folder; null when it may. */
export function skillFilePathProblem(path, folder = false) {
  const parts = path.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || [...part].some(unsafeCharacter) || /[. ]$/.test(part) ||
      WINDOWS_DEVICE.test(part) || Buffer.byteLength(part, "utf8") > 255) return "name";
    if (part.startsWith(".")) return "hidden";
    if (GENERATED.has(part.toLowerCase())) return "generated";
  }
  return parts.length > SKILL_FOLDER_LIMITS.depth - (folder ? 1 : 0) ? "deep" : null;
}

const depthOf = (path) => path.split("/").length;
const comparable = (path) => path.normalize("NFC").toLowerCase();

/** What of a folder listing comes in, SKILL.md first and shallow files before deep ones, within the limits. */
export function planSkillFolder(entries) {
  const ordered = [...entries].sort((a, b) => depthOf(a.path) - depthOf(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const skillMd = ordered.find((entry) => entry.path === "SKILL.md" && entry.kind === "file");
  const take = skillMd ? [skillMd] : [];
  const skipped = [];
  const closed = [];
  const held = new Map(skillMd ? [["skill.md", { spelling: "SKILL.md", folder: false }]] : []);
  let bytes = skillMd?.size ?? 0;
  const clashes = (path) => {
    const parts = path.split("/");
    return parts.some((_, index) => {
      const prefix = parts.slice(0, index + 1).join("/");
      const holder = held.get(comparable(prefix));
      return holder !== undefined && (index === parts.length - 1 || !holder.folder || holder.spelling !== prefix);
    });
  };
  const hold = (path) => {
    const parts = path.split("/");
    parts.forEach((_, index) => {
      const prefix = parts.slice(0, index + 1).join("/");
      held.set(comparable(prefix), { spelling: prefix, folder: index < parts.length - 1 });
    });
  };
  for (const entry of ordered) {
    if (entry === skillMd || closed.some((prefix) => entry.path.startsWith(prefix))) continue;
    const skip = (reason) => skipped.push({ path: entry.kind === "folder" ? `${entry.path}/` : entry.path, reason });
    if (entry.kind === "link" || entry.kind === "submodule") {
      skip(entry.kind);
      continue;
    }
    const problem = skillFilePathProblem(entry.path, entry.kind === "folder");
    if (problem) {
      skip(problem);
      if (entry.kind === "folder") closed.push(`${entry.path}/`);
      continue;
    }
    if (entry.kind === "folder") continue;
    if (entry.size > SKILL_FOLDER_LIMITS.fileBytes) skip("large");
    else if (clashes(entry.path)) skip("duplicate");
    else if (take.length >= SKILL_FOLDER_LIMITS.files || bytes + entry.size > SKILL_FOLDER_LIMITS.bytes) skip("full");
    else {
      take.push(entry);
      bytes += entry.size;
      hold(entry.path);
    }
  }
  return { take, skipped };
}
