// Google's update channel for the native Antigravity CLI, which serves ACP itself from 1.5.0 on.
//
// Adapted from pingdotgg/t3code@b732621b51, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/antigravityCliRelease.ts (the manifest address,
//     the per-platform targets, and the manifest's validation);
//   - apps/server/src/provider/AntigravityInstallation.ts:932-946 (the musl
//     check and the manifest request).
import { existsSync } from "node:fs";

import { parseVersionTriple, versionAtLeast } from "./acp/version-probe.ts";

export const ANTIGRAVITY_CLI_MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const MANIFEST_TIMEOUT_MS = 10_000;
const MANIFEST_MAX_BYTES = 64 * 1024;

export interface AntigravityCliReleaseAsset {
  version: string;
  url: string;
  sha512: string;
  executable: { name: string };
  format: "tar.gz" | "executable";
}

export function antigravityCliTarget(platform: NodeJS.Platform, arch: string, musl = false): string | null {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) return null;
  const os = platform === "win32" ? "windows" : platform;
  return `${os}_${arch === "x64" ? "amd64" : arch}${platform === "linux" && musl ? "_musl" : ""}`;
}

export function parseAntigravityCliRelease(
  value: unknown,
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): AntigravityCliReleaseAsset | null {
  const manifest = value as { version?: unknown; url?: unknown; sha512?: unknown } | null;
  if (
    !manifest || typeof manifest !== "object"
    || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(manifest.version)
    || typeof manifest.url !== "string"
    || typeof manifest.sha512 !== "string" || !/^[a-fA-F0-9]{128}$/u.test(manifest.sha512)
    || antigravityCliTarget(platform, arch, musl) === null
  ) return null;
  if (!versionAtLeast(parseVersionTriple(manifest.version)!, [1, 5, 0])) return null;
  const os = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
  const cpu = arch === "x64" ? "x64" : "arm64";
  const suffix = platform === "linux" && musl ? "_musl" : "";
  const extension = platform === "win32" ? "exe" : "tar.gz";
  const folder = `${platform === "win32" ? "windows" : platform}-${arch === "arm64" ? "arm" : "x64"}${suffix ? "-musl" : ""}`;
  const prefix = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${manifest.version}-`;
  const rest = manifest.url.startsWith(prefix) ? manifest.url.slice(prefix.length) : "";
  if (!/^\d+\//u.test(rest) || rest.replace(/^\d+\//u, "") !== `${folder}/cli_${os}_${cpu}${suffix}.${extension}`) return null;
  return {
    version: manifest.version,
    url: manifest.url,
    sha512: manifest.sha512.toLowerCase(),
    executable: { name: platform === "win32" ? "agy.exe" : "antigravity" },
    format: platform === "win32" ? "executable" : "tar.gz",
  };
}

export function hostUsesMusl(platform: NodeJS.Platform = process.platform, arch: string = process.arch, exists: (path: string) => boolean = existsSync): boolean {
  return platform === "linux" && exists(arch === "arm64" ? "/lib/libc.musl-aarch64.so.1" : "/lib/libc.musl-x86_64.so.1");
}

/** The release Google's channel offers this computer right now; null when it has none, cannot be reached, or names
 * anything but its own download for this platform. */
export async function latestAntigravityCliRelease(options: {
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  musl?: boolean;
} = {}): Promise<AntigravityCliReleaseAsset | null> {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const musl = options.musl ?? hostUsesMusl(platform, arch);
  const target = antigravityCliTarget(platform, arch, musl);
  if (target === null) return null;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${ANTIGRAVITY_CLI_MANIFEST_BASE}/${target}.json`, {
      redirect: "error", signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) return null;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > MANIFEST_MAX_BYTES) return null;
      chunks.push(Buffer.from(chunk));
    }
    return parseAntigravityCliRelease(JSON.parse(Buffer.concat(chunks).toString("utf8")), platform, arch, musl);
  } catch {
    return null;
  }
}
