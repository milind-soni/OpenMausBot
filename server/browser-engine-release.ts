// The pinned agent-browser release the harness downloads for the bots'
// browser (docs/plans/browser-engine.md). Digests were computed from the
// GitHub release assets on 2026-09-06; bump the version and every digest
// together, through a pull request whose end-to-end run exercises the binary.
// The Dockerfile pins the same version.
export const AGENT_BROWSER_VERSION = "0.36.0";

export interface AgentBrowserReleaseAsset {
  /** `<platform>-<arch>`; Linux adds `-musl` on Alpine-style systems. */
  target: string;
  /** File name on the GitHub release. */
  asset: string;
  sha256: string;
  bytes: number;
}

const RELEASES = new Map<string, AgentBrowserReleaseAsset>([
  [
    "darwin-arm64",
    { target: "darwin-arm64", asset: "agent-browser-darwin-arm64", sha256: "b2106ab39db0838e7b1772f7f26f760518de56d09053150c56f9dddf15af997d", bytes: 12363200 },
  ],
  [
    "darwin-x64",
    { target: "darwin-x64", asset: "agent-browser-darwin-x64", sha256: "45d9ac061a7d72e61eaff905326e2e19365f4dadb12142ea2f2d76d84689c708", bytes: 13510280 },
  ],
  [
    "linux-arm64",
    { target: "linux-arm64", asset: "agent-browser-linux-arm64", sha256: "aeb556addca3903601a433de1acad3ace1c9c61d170084bf58d875884599a990", bytes: 12442720 },
  ],
  [
    "linux-musl-arm64",
    { target: "linux-musl-arm64", asset: "agent-browser-linux-musl-arm64", sha256: "1ca7e003c9cb185f174fc81e51a609db27c77e3bfe00a0edff60688f8cd14f88", bytes: 12297000 },
  ],
  [
    "linux-musl-x64",
    { target: "linux-musl-x64", asset: "agent-browser-linux-musl-x64", sha256: "a20cc2a5202a48f5820372803dedbcd5f556dff7a89421f1b0f2612962b10718", bytes: 13995728 },
  ],
  [
    "linux-x64",
    { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: "56d15181e51e00213f907fcf39707cfc76bfa804ff20f5a9373661c73f96de5e", bytes: 14156776 },
  ],
  [
    "win32-x64",
    { target: "win32-x64", asset: "agent-browser-win32-x64.exe", sha256: "412ff72737a109e93f5304b0ff76c988fb6f1f451d0fc7e010577922bcc20ff3", bytes: 13837312 },
  ],
]);

export function agentBrowserReleaseUrl(asset: AgentBrowserReleaseAsset): string {
  return `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${asset.asset}`;
}

/** The asset for this machine, or null where Vercel publishes none. */
export function resolveAgentBrowserReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = false,
): AgentBrowserReleaseAsset | null {
  const key = platform === "linux" && musl ? `linux-musl-${arch}` : `${platform}-${arch}`;
  return RELEASES.get(key) ?? null;
}
