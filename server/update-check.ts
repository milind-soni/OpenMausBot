// "Check for updates" for a server the desktop app does not manage. The
// packaged app updates itself through its own updater; a self-hosted server
// cannot replace itself, so this only says whether a newer release exists
// and how this install is updated (MOCA-276).
import { existsSync } from "node:fs";
import { join, sep } from "node:path";

export const LATEST_RELEASE_URL = "https://api.github.com/repos/milind-soni/OpenMausBot/releases/latest";
const CACHE_MS = 60 * 60_000;

/** How this server was installed, which decides how it is updated.
 * "managed" is a hosted or Cloud server that is updated for its owner. */
export type InstallKind = "desktop" | "managed" | "docker" | "npm" | "git" | "unknown";

/** The command that updates each kind of install, as the docs give it. */
export const UPDATE_COMMANDS: Partial<Record<InstallKind, { command: string; restart: boolean }>> = {
  docker: { command: "docker compose pull omb && docker compose up -d", restart: false },
  npm: { command: "npm install -g openmausbot@latest", restart: true },
  git: { command: "git pull && pnpm install", restart: true },
};

export function installKind(input: {
  desktopManaged: boolean;
  managed: boolean;
  serverRoot: string;
  exists?: (path: string) => boolean;
}): InstallKind {
  const exists = input.exists ?? existsSync;
  if (input.desktopManaged) return "desktop";
  if (input.managed) return "managed";
  if (exists("/.dockerenv") || exists("/run/.containerenv")) return "docker";
  if (input.serverRoot.split(sep).includes("node_modules")) return "npm";
  if (exists(join(input.serverRoot, "..", ".git"))) return "git";
  return "unknown";
}

/** Whether `latest` is a newer release than `current`, comparing the
 * numeric parts of tags such as "v0.1.92". Anything unparseable is never
 * reported as an update. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (version: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

export interface UpdateCheck {
  current: string;
  install: InstallKind;
  latest?: string;
  available: boolean;
  releaseUrl?: string;
  command?: string;
  restart?: boolean;
}

/** One cached GitHub lookup an hour, shared by every caller, so opening
 * the menu on many devices never fans out into many requests. */
export function createUpdateChecker(options: {
  current: string;
  install: InstallKind;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const fetchRelease = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { at: number; result: UpdateCheck } | undefined;
  let inflight: Promise<UpdateCheck> | undefined;
  const base = (): UpdateCheck => ({
    current: options.current,
    install: options.install,
    available: false,
    ...UPDATE_COMMANDS[options.install],
  });

  return async function check(): Promise<UpdateCheck> {
    // A desktop or hosted server is updated elsewhere; nothing to look up.
    if (options.install === "desktop" || options.install === "managed") return base();
    if (cached && now() - cached.at < CACHE_MS) return cached.result;
    inflight ??= (async () => {
      try {
        const response = await fetchRelease(LATEST_RELEASE_URL, {
          headers: { accept: "application/vnd.github+json", "user-agent": "openmausbot-update-check" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
        const release = await response.json() as { tag_name?: unknown; html_url?: unknown };
        if (typeof release.tag_name !== "string") throw new Error("GitHub sent no release tag");
        const latest = release.tag_name.replace(/^v/, "");
        const result: UpdateCheck = {
          ...base(),
          latest,
          available: isNewerVersion(latest, options.current),
          ...(typeof release.html_url === "string" ? { releaseUrl: release.html_url } : {}),
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
