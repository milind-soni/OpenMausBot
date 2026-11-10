// A self-hosted server cannot replace itself, so this only says whether a newer version exists and how this install is updated.
import { existsSync } from "node:fs";
import { join, sep } from "node:path";

export const LATEST_RELEASE_URL = "https://api.github.com/repos/milind-soni/OpenMausBot/releases/latest";
/** Written by .github/workflows/promote-stable.yml: the released version our own Clouds have run for 48 hours. */
export const STABLE_CHANNEL_URL = "https://raw.githubusercontent.com/milind-soni/OpenMausBot/channels/stable.json";
const CACHE_MS = 60 * 60_000;

/** "managed" is a hosted or Cloud server that is updated for its owner. */
export type InstallKind = "desktop" | "managed" | "docker" | "podman" | "npm" | "git" | "unknown";

/** `stable` follows the promoted version; `newest` follows every release, as soon as it is published. */
export type UpdateChannel = "stable" | "newest";

/** OMB_UPDATE_CHANNEL: `newest` to hear of every release; anything else is `stable`. */
export function updateChannel(env: NodeJS.ProcessEnv = process.env): UpdateChannel {
  return env.OMB_UPDATE_CHANNEL?.trim().toLowerCase() === "newest" ? "newest" : "stable";
}

/**
 * As docs/self-hosting.md and deploy/podman/README.md give them. `version` is the one the channel names: an npm install
 * is pinned to it, and a Docker install passes it to deploy/update.sh unless that is the stable one update.sh takes anyway.
 */
export function updateCommand(install: InstallKind, target?: { version: string; stable: boolean }): { command: string; restart: boolean } | undefined {
  switch (install) {
    case "docker": return { command: target && !target.stable ? `git pull && ./update.sh --version ${target.version}` : "git pull && ./update.sh", restart: false };
    case "podman": return { command: "git pull && cd deploy/podman && PODMAN_COMPOSE_PROVIDER=podman-compose podman compose --env-file .env -f compose.yaml up -d --build", restart: false };
    case "npm": return { command: `npm install -g openmausbot@${target?.version ?? "latest"}`, restart: true };
    case "git": return { command: "git pull && pnpm install", restart: true };
    default: return undefined;
  }
}

export function installKind(input: {
  desktopManaged: boolean;
  managed: boolean;
  serverRoot: string;
  exists?: (path: string) => boolean;
}): InstallKind {
  const exists = input.exists ?? existsSync;
  if (input.desktopManaged) return "desktop";
  if (input.managed) return "managed";
  if (exists("/.dockerenv")) return "docker";
  if (exists("/run/.containerenv")) return "podman";
  if (input.serverRoot.split(sep).includes("node_modules")) return "npm";
  if (exists(join(input.serverRoot, "..", ".git"))) return "git";
  return "unknown";
}

/** Semver order on tags such as "v0.1.92"; a prerelease sorts before its release, and anything unparseable is never an update. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (version: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
    return match ? { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? [] } : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i]! !== b.core[i]!) return a.core[i]! > b.core[i]!;
  }
  if (!a.pre.length || !b.pre.length) return !a.pre.length && b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return y === undefined;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y);
    if (xn !== yn) return yn;
    return x > y;
  }
  return false;
}

export interface UpdateCheck {
  current: string;
  install: InstallKind;
  /** Where `latest` came from. `stable` falls back to `newest` until a first version has been promoted. */
  channel?: UpdateChannel;
  latest?: string;
  available: boolean;
  releaseUrl?: string;
  command?: string;
  restart?: boolean;
}

type Found = { version: string; releaseUrl?: string };

/** One cached lookup an hour, shared by every caller. */
export function createUpdateChecker(options: {
  current: string;
  install: InstallKind;
  channel?: UpdateChannel;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const fetchJson = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const channel = options.channel ?? "stable";
  let cached: { at: number; result: UpdateCheck } | undefined;
  let inflight: Promise<UpdateCheck> | undefined;
  const base = (): UpdateCheck => ({
    current: options.current,
    install: options.install,
    available: false,
    ...updateCommand(options.install),
  });
  const ask = (url: string) => fetchJson(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "openmausbot-update-check" },
    signal: AbortSignal.timeout(8_000),
  });

  /** Null until a first version has been promoted: the record does not exist yet. */
  async function stable(): Promise<Found | null> {
    const response = await ask(STABLE_CHANNEL_URL);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`The stable channel answered ${response.status}`);
    const record = await response.json() as { version?: unknown; releaseUrl?: unknown };
    if (typeof record.version !== "string" || !/^\d+\.\d+\.\d+$/.test(record.version)) throw new Error("The stable channel named no version");
    return { version: record.version, ...(typeof record.releaseUrl === "string" ? { releaseUrl: record.releaseUrl } : {}) };
  }

  async function newest(): Promise<Found> {
    const response = await ask(LATEST_RELEASE_URL);
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const release = await response.json() as { tag_name?: unknown; html_url?: unknown };
    if (typeof release.tag_name !== "string") throw new Error("GitHub sent no release tag");
    return { version: release.tag_name.replace(/^v/, ""), ...(typeof release.html_url === "string" ? { releaseUrl: release.html_url } : {}) };
  }

  return async function check(): Promise<UpdateCheck> {
    if (options.install === "desktop" || options.install === "managed") return base();
    if (cached && now() - cached.at < CACHE_MS) return cached.result;
    inflight ??= (async () => {
      try {
        const promoted = channel === "stable" ? await stable() : null;
        const found = promoted ?? await newest();
        const result: UpdateCheck = {
          ...base(),
          channel: promoted ? "stable" : "newest",
          latest: found.version,
          available: isNewerVersion(found.version, options.current),
          ...(found.releaseUrl ? { releaseUrl: found.releaseUrl } : {}),
          ...updateCommand(options.install, { version: found.version, stable: promoted !== null }),
        };
        cached = { at: now(), result };
        return result;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
}
