// Digests computed from the official GitHub assets on 2026-11-25, except the versioned Windows vendor build; update pins
// only through a reviewed native end-to-end run. The Dockerfile keeps the official Linux version.
export const AGENT_BROWSER_VERSION = "0.39.0";

export interface AgentBrowserReleaseAsset {
  /** `<platform>-<arch>`; Linux adds `-musl` on Alpine-style systems. */
  target: string;
  asset: string;
  sha256: string;
  bytes: number;
  /** A reviewed platform-specific vendor revision; other assets use the upstream version. */
  version?: string;
  /** Exact release URL for a reviewed vendor build, never a mutable latest URL. */
  url?: string;
}

const RELEASES = new Map<string, AgentBrowserReleaseAsset>([
  [
    "darwin-arm64",
    { target: "darwin-arm64", asset: "agent-browser-darwin-arm64", sha256: "636fc9aa269e3819b539998aa5b87e1c3953556c19eeb9685053743283464faa", bytes: 15803424 },
  ],
  [
    "darwin-x64",
    { target: "darwin-x64", asset: "agent-browser-darwin-x64", sha256: "c080b1c2c4f03c2690778d72f30a0f8807cea1a5946b71e0ab6d71498f2d573e", bytes: 17433384 },
  ],
  [
    "linux-arm64",
    { target: "linux-arm64", asset: "agent-browser-linux-arm64", sha256: "54eedbcaedcbd8b49f840098ea85dda653af0a036e28609b526ece068de6c0ab", bytes: 15842192 },
  ],
  [
    "linux-musl-arm64",
    { target: "linux-musl-arm64", asset: "agent-browser-linux-musl-arm64", sha256: "e63f7aa47bff381469e8c34c2f3c2fe317a607b1ce1a0a712a9896a8de07ac43", bytes: 15640568 },
  ],
  [
    "linux-musl-x64",
    { target: "linux-musl-x64", asset: "agent-browser-linux-musl-x64", sha256: "6adeb7e2466f0d9ea4ef562222e221bfdd067f5545d7b052dc64fb13ba250f48", bytes: 18099904 },
  ],
  [
    "linux-x64",
    { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: "d258593db4899577748a4b2a671a315f76f07a4553ba7fbbeaa95f0d16a4aaa8", bytes: 18302648 },
  ],
  [
    "win32-x64",
    {
      // Upstream 0.39.0 still lacks vercel-labs/agent-browser#1781's Windows cold-start fix.
      // Retain the native-verified revision until its replacement is tested.
      target: "win32-x64", version: "0.36.0-omb.1",
      asset: "agent-browser-win32-x64-0.36.0-omb.1.exe",
      url: "https://github.com/milind-soni/OpenMausBot/releases/download/browser-engine-v0.36.0-omb.1/agent-browser-win32-x64-0.36.0-omb.1.exe",
      sha256: "33bee834f6a6072ec8688b0914726e0262874d758f69f27e8baf7eaac6b5ed15", bytes: 13806080,
    },
  ],
]);

export function agentBrowserReleaseUrl(asset: AgentBrowserReleaseAsset): string {
  return asset.url ?? `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${asset.asset}`;
}

export function agentBrowserReleaseVersion(asset: AgentBrowserReleaseAsset | null): string {
  return asset?.version ?? AGENT_BROWSER_VERSION;
}

/**
 * The Linux-family key for this platform, or null when Vercel publishes nothing usable.
 *
 * Android is not musl: Termux runs the platform's bionic loader, so neither
 * `linux-<arch>` (glibc) nor `linux-musl-<arch>` describes it. What actually works
 * there is the statically linked musl build, which carries its own libc and needs no
 * interpreter at all. Keying Android to `linux-musl-<arch>` therefore picks the one
 * asset that runs, instead of reporting a build that does exist as missing.
 */
function linuxFamilyKey(platform: NodeJS.Platform, arch: string, musl: boolean): string {
  if (platform === "android") return `linux-musl-${arch}`;
  if (platform === "linux" && musl) return `linux-musl-${arch}`;
  return `${platform}-${arch}`;
}

/** The asset for this machine, or null where Vercel publishes none. */
export function resolveAgentBrowserReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = false,
): AgentBrowserReleaseAsset | null {
  return RELEASES.get(linuxFamilyKey(platform, arch, musl)) ?? null;
}

