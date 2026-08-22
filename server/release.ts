import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const __OMB_SOURCE_SHA__: string | undefined;

function cleanSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

let cachedSourceSha: string | undefined;

/** Exact source identity compiled into packaged server entries. Development
 * falls back to the current checkout; an unknown value is explicit rather
 * than being confused with the installed application's version. */
export function runtimeSourceSha(): string {
  if (cachedSourceSha !== undefined) return cachedSourceSha;
  const fromEnv = cleanSha(process.env.OMB_SOURCE_SHA);
  if (fromEnv) return (cachedSourceSha = fromEnv);
  const compiled = typeof __OMB_SOURCE_SHA__ === "undefined" ? null : cleanSha(__OMB_SOURCE_SHA__);
  if (compiled) return (cachedSourceSha = compiled);
  try {
    cachedSourceSha = cleanSha(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    })) ?? "unknown";
  } catch {
    cachedSourceSha = "unknown";
  }
  return cachedSourceSha;
}

export function runtimeRelease(): string {
  const configured = process.env.OMB_RELEASE?.trim();
  if (configured) return configured.slice(0, 80);
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    const parsed = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "development";
  } catch {
    return "development";
  }
}
