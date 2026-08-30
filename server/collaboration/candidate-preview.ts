import { spawnSync } from "node:child_process";

const FULL_SHA = /^[0-9a-f]{40}$/iu;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_CANDIDATE_PREVIEW_CHARACTERS = 3_500;

function isSafePreviewPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(path)) {
    return false;
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  const lower = path.toLowerCase();
  return !(
    segments.some((segment) => segment === ".git" || segment === ".env" || segment.startsWith(".env.")) ||
    /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials?|secrets?)(?:\.|$)/u.test(lower) ||
    /\.(?:key|pem|p12|pfx)$/u.test(lower)
  );
}

function sanitizeDiff(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .trim();
}

export function renderCandidateDiffPreview(input: {
  repository: string;
  baseSha: string;
  resultSha: string;
  changedPaths: readonly string[];
  maximumCharacters?: number;
}): string | undefined {
  if (!FULL_SHA.test(input.baseSha) || !FULL_SHA.test(input.resultSha)) return undefined;
  const paths = [...new Set(input.changedPaths)].filter(isSafePreviewPath);
  if (!paths.length) return undefined;
  const result = spawnSync(
    "git",
    ["diff", "--no-ext-diff", "--no-color", "--unified=3", input.baseSha, input.resultSha, "--", ...paths],
    {
      cwd: input.repository,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    },
  );
  if (result.status !== 0 || result.error) return undefined;
  const preview = sanitizeDiff(result.stdout);
  if (!preview) return undefined;
  const maximum = Math.max(256, Math.min(input.maximumCharacters ?? DEFAULT_CANDIDATE_PREVIEW_CHARACTERS, 20_000));
  if (preview.length <= maximum) return preview;
  return `${preview.slice(0, maximum - 28).trimEnd()}\n… candidate diff truncated`;
}
