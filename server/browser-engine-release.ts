// Digests computed from the official GitHub assets on 2026-09-08, except the versioned Windows vendor build; update pins
// only through a reviewed native end-to-end run. The Dockerfile keeps the official Linux version.
export const AGENT_BROWSER_VERSION = "0.37.0";

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
    { target: "darwin-arm64", asset: "agent-browser-darwin-arm64", sha256: "da5a2b4ef7be8ba279b1258c542c33877f480b1951d0d94de607fc1528edd380", bytes: 12429360 },
  ],
  [
    "darwin-x64",
    { target: "darwin-x64", asset: "agent-browser-darwin-x64", sha256: "f402c96350ffd2adc68d0e5e4d83aa49cf7735fef29882a8866be36cc2fc67e9", bytes: 13588296 },
  ],
  [
    "linux-arm64",
    { target: "linux-arm64", asset: "agent-browser-linux-arm64", sha256: "0315a8c4f7bf167cc5fd5eeaea79009b0e6b5d2ae8b3057bf6f96be978483426", bytes: 12507840 },
  ],
  [
    "linux-musl-arm64",
    { target: "linux-musl-arm64", asset: "agent-browser-linux-musl-arm64", sha256: "db67c0e84e0668c052c2cbdca325c57f896e309c3723755dcdd65b700f8a2b52", bytes: 12369352 },
  ],
  [
    "linux-musl-x64",
    { target: "linux-musl-x64", asset: "agent-browser-linux-musl-x64", sha256: "5cff3bc7b2486867aba2901f92c9ce6029bd2a37951630d9feec1c5b3fee402e", bytes: 14092888 },
  ],
  [
    "linux-x64",
    { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: "78e0c5a14a7fa1f3d1ae2acdbdcc94a047b435b998a8c505fcc49d7fa4935a49", bytes: 14253776 },
  ],
  [
    "win32-x64",
    {
      // Upstream 0.37.0 still lacks vercel-labs/agent-browser#1781's Windows cold-start fix.
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

export { linuxFamilyKey };
