// What each path on a Cloud home's volume is, by where the server, its engines and its browser write. The volume is HOME
// (/data, Dockerfile), and the data folder (OMB_DATA_DIR, /data/.openmausbot) sits inside it; a path is read as segments
// relative to one of the two. Privacy invariant: nothing here returns a name taken from the disk except a bot id (which the
// report shows only for bots the store knows) and a name from OTHER_NAMES.
import { TOOL_CACHES, TOOL_CACHE_DIR } from "../bot-box/tool-caches.ts";

/** `precious`: losing it loses something only this home holds. `work`: what bots and people made or may still read,
 * which only doing the work again would bring back. `rebuildable`: the code named next to it makes it again when it is
 * missing. Security invariant: only a name listed here as rebuildable is ever rebuildable; anything unknown is `other`. */
export type StorageClass = "precious" | "work" | "rebuildable";

export const STORAGE_CATEGORIES = {
  conversations: "precious",
  settings: "precious",
  engine_state: "precious",
  browser_profiles: "precious",
  bot_files: "work",
  attachments: "work",
  synced: "work",
  backups: "work",
  trash: "work",
  other: "work",
  // Chrome rebuilds its own caches; temporary profiles are made per use (browser/chrome/profile.ts profileDir).
  browser_cache: "rebuildable",
  // tools/chrome: browser/chrome/install.ts; tools/agent-browser: browser-engine.ts; ~/.cache/ms-playwright: Playwright.
  browser_engines: "rebuildable",
  // tools/npm and its siblings: engine-install.ts and engine-npm-update.ts install them again on first use.
  engine_clis: "rebuildable",
  // npm, pnpm, pip, uv, cargo and bun fetch packages again; node_modules is rebuilt by its project's install.
  packages: "rebuildable",
  // History people may still read (service logs, the timings, what each run started): nothing makes it again.
  logs: "work",
  // Node's compile cache (cloud-home-start.ts NODE_COMPILE_CACHE), DuckDB's extensions (data/engine.ts) and tools' caches.
  caches: "rebuildable",
  // Scratch space a running step made for itself and removes when it ends.
  temp: "rebuildable",
} as const satisfies Record<string, StorageClass>;
export type StorageCategory = keyof typeof STORAGE_CATEGORIES;

export type StorageScope = "data" | "home";

/** First-level names in `other` that our own code or the filesystem makes, so they may be named in the report. */
export const OTHER_NAMES: ReadonlySet<string> = new Set(["lost+found", ".bash_history", ".lesshst", ".wget-hsts", ".python_history", ".node_repl_history"]);

/** A folder of a bot that holds per-bot files, `<folder>/<bot id>/…`. */
const BOT_FOLDERS: ReadonlySet<string> = new Set(["workspaces", "task-workspaces", "bots"]);
const BOT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface Placement {
  category: StorageCategory;
  /** `workspaces/<id>`, `task-workspaces/<id>`, `bots/<id>`: a candidate bot id, shown only if the store knows it. */
  botId?: string;
  /** Only names in OTHER_NAMES. */
  otherName?: string;
  /** No deeper segment changes the category, except a `node_modules` under a work folder. */
  final: boolean;
}

const at = (category: StorageCategory, final = true): Placement => ({ category, final });

/** Data folder, first level, folders. */
const DATA_FOLDERS: Readonly<Record<string, StorageCategory>> = {
  // config.ts EVENTS_DIR and NATIVE_DIR: each conversation's event log; checkpoints.ts; memory-journal.ts.
  events: "conversations", native: "conversations", checkpoints: "conversations", "memory-journal": "conversations",
  // Sign-ins and settings: providers (provider logins), people and people-connections (team-connections.ts), caddy
  // (caddy.ts), ssh (vps-ssh.ts), the skills folders (index.ts, skill-library.ts, imported-skills.ts), themes
  // (themes/store.ts), org-library (org-library.ts), share (share.ts), usage (usage-ledger.ts), decisions and
  // admin-activity (decision-log.ts, admin-activity.ts: the audit log readDecisions reads), prompt-split (drivers/prompt-split.ts),
  // codex-instructions (drivers/codex-instructions.ts), local-vm-stops, skill-switch, hook-tokens (drivers/claude.ts),
  // claude-user-skills (turn-settings.ts), box (bot-box/boot.ts), github (github/sign-in.ts).
  providers: "settings", people: "settings", "people-connections": "settings", caddy: "settings", ssh: "settings",
  skills: "settings", "skills-library": "settings", "imported-skills": "settings", "skill-state": "settings", "skill-switch": "settings",
  themes: "settings", "org-library": "settings", share: "settings", usage: "settings", decisions: "settings", "admin-activity": "settings",
  "prompt-split": "settings", "codex-instructions": "settings", "local-vm-stops": "settings", "hook-tokens": "settings",
  "claude-user-skills": "settings", box: "settings", github: "settings",
  // engine-homes/layout.ts (a Team Cloud's per-audience engine homes); drivers/pi-session.ts.
  "engine-homes": "engine_state", "pi-sessions": "engine_state",
  // host/team-files.ts (container-computer.ts's vm-home and vm-homes are placed in dataPlacement).
  "team-files": "bot_files",
  // attachments.ts, attachment-originals.ts, box-uploads (attachments.ts), host/browser.ts, tool-results
  // (mcp-gate-config.ts), meetings/manager.ts, evidence (browser-evidence.ts: the browser steps' screenshots a
  // conversation still shows).
  attachments: "attachments", "attachment-originals": "attachments", "box-uploads": "attachments", "browser-uploads": "attachments",
  "tool-results": "attachments", meetings: "attachments", evidence: "attachments",
  // cloud-sync-store.ts: what a desktop lent this Cloud.
  sync: "synced",
  // workspace-backup.ts (backup and restore jobs, the restore's safety copy); doctor/backup.ts.
  ".backups": "backups", "doctor-backups": "backups",
  // cli.ts and service-unit.ts (service logs), decider/log.ts, engine-records.ts (what each server run started).
  logs: "logs", "decider-log": "logs", "engine-runs": "logs",
  // Made again on first use: phone-screen/scrcpy-server-file.ts downloads scrcpy; service-cli.ts installs the app copy;
  // tunnel.ts prepares cloudflared in dist-native again when it is missing.
  scrcpy: "engine_clis", app: "engine_clis", "dist-native": "engine_clis",
  // excludedWorkspaceAuthPath (workspace-backup-policy.ts): login profiles of older browser engines.
  "chrome-profile": "browser_profiles", ".agent-browser": "browser_profiles",
  "duckdb-extensions": "caches", cache: "caches",
  // cloud-send-files.ts and the MCP configs; tunnel.ts TUNNEL_RUNTIME_DIR.
  tmp: "temp", ".tmp": "temp", "tunnel-runtime": "temp",
};

/** `tools/<name>` in the data folder (engine-roots.ts, browser/chrome/install.ts, browser-engine.ts ENGINE_DIR). */
const TOOL_FOLDERS: Readonly<Record<string, StorageCategory>> = {
  chrome: "browser_engines", "agent-browser": "browser_engines",
  npm: "engine_clis", standalone: "engine_clis", "antigravity-acp": "engine_clis",
};

/** Data folder, first level, files: the rest of the first-level files are settings and state files. */
const DATA_FILES: Readonly<Record<string, StorageCategory>> = {
  "perf-timings.json": "logs", "perf-stalls.json": "logs", "launch-timings.json": "logs",
};
const CONVERSATION_DB = /^(?:messages|runtime|bursts)\.db(?:-wal|-shm|-journal)?$/;

/** Folders Chrome downloads or computes again by itself inside a profile (`<profile>/Default/<name>` or `<profile>/<name>`). */
const CHROME_CACHES: ReadonlySet<string> = new Set([
  "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GraphiteDawnCache", "GrShaderCache", "ShaderCache",
  "component_crx_cache", "extensions_crx_cache", "optimization_guide_model_store", "Crashpad", "BrowserMetrics", "Safe Browsing",
  "OnDeviceHeadSuggestModel", "screen_ai",
]);
/** `Service Worker/<name>`: only the fetched copies; the registrations beside them are the site's state. */
const SERVICE_WORKER_CACHES: ReadonlySet<string> = new Set(["CacheStorage", "ScriptCache"]);

/** A browser profile folder `<root>/<profile>/…`, `rest` being what is under the profile. */
function profilePlacement(rest: readonly string[]): Placement {
  const [first, second, third] = rest;
  if (first === undefined) return at("browser_profiles", false);
  if (CHROME_CACHES.has(first)) return at("browser_cache");
  if (second === undefined) return at("browser_profiles", false);
  if (CHROME_CACHES.has(second)) return at("browser_cache");
  if (second !== "Service Worker") return at("browser_profiles");
  if (third === undefined) return at("browser_profiles", false);
  return at(SERVICE_WORKER_CACHES.has(third) ? "browser_cache" : "browser_profiles");
}

/** `browser/<name>` (browser/chrome/profile.ts browserRoot). */
const BROWSER_ENTRIES: Readonly<Record<string, StorageCategory>> = {
  // The bot's downloads (browser/service.ts downloadDir) and the screenshots it took (#saveScreenshot) are its work.
  downloads: "attachments", screenshots: "attachments",
  // workspace-id (profile.ts), the per-member profiles' record (host/browser.ts AudienceBrowsers, read to erase a deleted
  // bot's profiles) and the panes each profile opened (pane/backend.ts marksDir).
  "workspace-id": "browser_profiles", "audiences.json": "browser_profiles", panes: "browser_profiles",
  // Temporary profiles, swept when unused (chrome/processes.ts); a display's runtime files (desktop/displays.ts); the
  // calibrated identity, measured again when missing (chrome/calibrate.ts).
  temp: "browser_cache", displays: "browser_cache", identity: "browser_cache",
};

function browserPlacement(rest: readonly string[]): Placement {
  const [first] = rest;
  if (first === undefined) return at("browser_profiles", false);
  if (first === "profiles") return rest.length < 2 ? at("browser_profiles", false) : profilePlacement(rest.slice(2));
  return at(BROWSER_ENTRIES[first] ?? "other");
}

function dataPlacement(segments: readonly string[], directory: boolean): Placement {
  const [first, second, third] = segments;
  if (first === undefined) return at("settings", false);
  if (segments.length === 1 && !directory) {
    if (CONVERSATION_DB.test(first)) return at("conversations");
    if (DATA_FILES[first]) return at(DATA_FILES[first]);
    // decision-log.ts keeps the audit log's older file beside the current one.
    if (first === "decisions.ndjson" || first === "decisions.ndjson.1") return at("settings");
    if (first.endsWith(".log")) return at("logs");
    // atomic.ts writeWhole: `<file>.<pid>.<uuid>.tmp`, renamed over the file once written; one left is a crashed write.
    if (/\.\d+\.[0-9a-f-]{36}\.tmp$/.test(first)) return at("temp");
    return at("settings");
  }
  if (BOT_FOLDERS.has(first)) {
    if (second === undefined) return at("bot_files", false);
    const botId = BOT_ID.test(second) ? second : undefined;
    // dataEngineSpillPath (workspace-backup-policy.ts): DuckDB's spill folder, emptied when the database closes.
    if (first === "bots" && third === "data-tmp") return { category: "temp", final: true, ...(botId ? { botId } : {}) };
    return { category: "bot_files", final: first !== "bots" || segments.length >= 3, ...(botId ? { botId } : {}) };
  }
  if (first === "browser") return browserPlacement(segments.slice(1));
  // excludedWorkspaceAuthPath: a container computer's browser logins.
  if ((first === "vm-home" && second === ".browser-profiles") || (first === "vm-homes" && third === ".browser-profiles")) return at("browser_profiles");
  if (first === "vm-home" || first === "vm-homes") return { category: "bot_files", final: segments.length >= (first === "vm-home" ? 2 : 3) };
  // browser-engine.ts browserProfilesRoot: agent-browser's own profiles.
  if (first === "agent-browser-profiles") return segments.length < 2 ? at("browser_profiles", false) : profilePlacement(segments.slice(2));
  if (first === "tools") {
    if (second === undefined) return at("engine_clis", false);
    // engine-npm-update.ts and engine-standalone.ts stage an update beside the copy it replaces.
    if (second.startsWith(".npm-staging-") || second.startsWith(".npm-aside-") || second.startsWith(".staging-")) return at("temp");
    // engine-install.ts npmServerHome: npm's own config files beside its download cache.
    if (second === "npm-home") return third === undefined ? at("engine_clis", false) : at(third === "cache" ? "packages" : "settings");
    // host/bitwarden-cli.ts puts the tool in tools/bitwarden/<version>; bitwarden-vault.ts keeps the signed-in account
    // and its encrypted copy of the vault in tools/bitwarden/account.
    if (second === "bitwarden") return third === undefined ? at("engine_clis", false) : at(third === "account" ? "settings" : /^\d[\w.-]*$/.test(third) ? "engine_clis" : "other");
    return at(TOOL_FOLDERS[second] ?? "other");
  }
  if (first === "sync") {
    if (second === undefined) return at("synced", false);
    // cloud-sync-store.ts: deleted synced files wait in trash; uploads hold parts of a transfer still under way.
    if (second === "trash") return at("trash");
    if (second === "uploads") return at("temp");
    return at("synced");
  }
  if (first === "engine-homes") {
    if (second === undefined) return at("engine_state", false);
    // engine-homes/layout.ts HELD_DIR: state from before the split, deleted after HELD_DAYS.
    if (second === ".held") return at("trash");
    // An audience's own tool cache folder (bot-box/tool-caches.ts, OMB_CACHE_ROOT); the rest of its home is engine state.
    if (third === undefined) return at("engine_state", false);
    if (third === TOOL_CACHE_DIR) return toolCachePlacement(segments.slice(3));
    return at("engine_state");
  }
  if (first === "org-library") {
    if (second === undefined) return at("settings", false);
    // redownloadedOrgLibraryPath (workspace-backup-policy.ts): the library's files come again from the Admin.
    return second === "blobs" ? at("caches") : at("settings");
  }
  const known = DATA_FOLDERS[first];
  return known ? at(known) : at("other");
}

/** HOME, first level: engine homes (engine-homes/layout.ts ENGINE_FOLDERS and the drivers), sign-ins and dotfiles. */
const HOME_FOLDERS: Readonly<Record<string, StorageCategory>> = {
  ".claude": "engine_state", ".codex": "engine_state", ".kimi-code": "engine_state", ".dsh": "engine_state",
  ".hermes": "engine_state", ".qwen": "engine_state", ".factory": "engine_state", ".pi": "engine_state", ".gemini": "engine_state",
  ".copilot": "engine_state", ".cline": "engine_state", ".cursor": "engine_state", ".opencode": "engine_state", ".mmx": "engine_state",
  ".config": "settings", ".ssh": "settings", ".gnupg": "settings",
  // cloud-home-start.ts edgeCertificateStorage: the edge's TLS certificates.
  ".omb-edge": "settings",
  // npm's and pnpm's own cache and store folders: nothing but downloaded packages.
  ".npm": "packages", ".pnpm-store": "packages",
  // cloud-sync-paths.ts syncRoot: the person's synced folders.
  Synced: "synced",
};
/** HOME, first level, files. */
const HOME_FILES: Readonly<Record<string, StorageCategory>> = {
  ".claude.json": "engine_state", ".claude.json.backup": "engine_state",
  // cloud-home.ts CLOUD_HOME_MARKER and the dotfiles a fresh volume may hold (cloud-home.ts ADOPTABLE).
  ".omb-cloud-home.json": "settings", ".bashrc": "settings", ".profile": "settings", ".bash_logout": "settings", ".gitconfig": "settings",
  ".npmrc": "settings",
};
/** Download caches inside tool folders that also hold what people installed or wrote: only these subfolders are packages. */
const HOME_PACKAGE_CACHES: ReadonlyArray<readonly [string, string, string?]> = [
  [".cargo", "registry"], [".cargo", "git"], ["go", "pkg", "mod"], [".m2", "repository"], [".gradle", "caches"], [".bun", "install", "cache"], [".yarn", "berry", "cache"],
];

/** `~/.cache/<name>`: browser engines, package stores and caches; any other name is `other` (a token may live there). */
const HOME_CACHES: Readonly<Record<string, StorageCategory>> = {
  "ms-playwright": "browser_engines", puppeteer: "browser_engines",
  pip: "packages", uv: "packages", pnpm: "packages", yarn: "packages", "node-gyp": "packages", npm: "packages", bun: "packages",
  "pypoetry": "packages", "go-build": "packages",
  // model-catalog/catalog.ts: opencode's model list, fetched again.
  opencode: "caches",
};

/** The tool cache folder's own folders (bot-box/tool-caches.ts TOOL_CACHES), each a download cache; any other name in it
 * (what a bot put in ~/cache before, a token) is `other`. By name only, like `~/.cache/<name>` above: a person's own
 * `~/cache/npm` in a folder the server did not make (no CACHEDIR.TAG) is labelled a cache too. Only the storage report
 * reads this; nothing deletes by it (the cache cap checks the mark itself, server/cache-sweep). */
const TOOL_CACHE_FOLDERS = TOOL_CACHES.map((cache) => cache.folder.split("/"));
function toolCachePlacement(rest: readonly string[]): Placement {
  if (rest.length === 0) return at("caches", false);
  let partial = false;
  for (const parts of TOOL_CACHE_FOLDERS) {
    const shared = Math.min(parts.length, rest.length);
    if (!parts.slice(0, shared).every((part, index) => rest[index] === part)) continue;
    if (rest.length >= parts.length) return at("caches");
    partial = true;
  }
  return partial ? at("other", false) : at("other");
}

function homePlacement(segments: readonly string[], directory: boolean): Placement {
  const [first, second, third] = segments;
  if (first === undefined) return at("other", false);
  if (segments.length === 1 && !directory) {
    const known = HOME_FILES[first];
    if (known) return at(known);
    return OTHER_NAMES.has(first) ? { category: "other", otherName: first, final: true } : at("other");
  }
  // The tools' cache folder with OMB_CACHE_ROOT on (bot-box/tool-caches.ts TOOL_CACHE_DIR).
  if (first === TOOL_CACHE_DIR) return toolCachePlacement(segments.slice(1));
  if (first === ".cache") return second === undefined ? at("caches", false) : at(HOME_CACHES[second] ?? "other");
  if (first === ".local") {
    if (second === undefined) return at("other", false);
    if (second !== "share" && second !== "state") return at("other");
    if (third === undefined) return at("other", false);
    // The Claude native installer keeps each version under ~/.local/share/claude (env-path.ts), and its locks under
    // ~/.local/state/claude.
    if (third === "claude") return at("engine_clis");
    // pnpm's content-addressed store; its global installs beside it are not a cache.
    if (third === "pnpm") return segments.length < 4 ? at("other", false) : at(segments[3] === "store" ? "packages" : "other");
    if (third === "Trash") return at("trash");
    if (third === "opencode") return at("engine_state");
    return at("other");
  }
  // browser-engine.ts browserSessionsDirectory: agent-browser's saved sessions (sign-ins); its own browsers under it.
  if (first === ".agent-browser") return second === undefined ? at("browser_profiles", false) : at(second === "browsers" ? "browser_engines" : "browser_profiles");
  // The Grok installer puts its binary in ~/.grok/bin (Dockerfile); the rest of ~/.grok is its sign-in and sessions.
  if (first === ".grok") return second === undefined ? at("engine_state", false) : at(second === "bin" ? "engine_clis" : "engine_state");
  for (const cache of HOME_PACKAGE_CACHES) {
    if (cache[0] !== first) continue;
    if (segments.length < cache.length) return at("other", false);
    return at(cache.every((part, index) => segments[index] === part) ? "packages" : "other");
  }
  const known = HOME_FOLDERS[first];
  if (known) return at(known);
  return OTHER_NAMES.has(first) ? { category: "other", otherName: first, final: true } : at("other");
}

/** Where a path is, from its segments relative to the scope's root (the data folder or HOME). */
export function placeStoragePath(scope: StorageScope, segments: readonly string[], directory: boolean): Placement {
  return scope === "data" ? dataPlacement(segments, directory) : homePlacement(segments, directory);
}

/** Folders whose `node_modules` is counted as packages: the ones holding what people and bots made. */
const PACKAGE_HOSTS: ReadonlySet<StorageCategory> = new Set(["bot_files", "synced", "other", "attachments"]);

/** A child's placement from its parent's: the classifier is asked only while the parent's is not final. */
export function placeChild(parent: Placement, scope: StorageScope, segments: readonly string[], directory: boolean): Placement {
  const name = segments.at(-1);
  if (directory && name === "node_modules" && PACKAGE_HOSTS.has(parent.category)) return { category: "packages", final: true, ...(parent.botId ? { botId: parent.botId } : {}) };
  if (parent.final) return parent;
  const placed = placeStoragePath(scope, segments, directory);
  return parent.botId && !placed.botId ? { ...placed, botId: parent.botId } : placed;
}

/** Path segments of `relative`, which may use either separator (a Windows data folder). */
export function storageSegments(relative: string): string[] {
  return relative.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
}
