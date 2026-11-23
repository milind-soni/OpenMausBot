// Tool caches on a Cloud home (docs/bot-box.md, "Tool caches"). With OMB_CACHE_ROOT on, what a bot's tools download again
// whenever it is missing (npm's and pip's packages, uv's wheels, Hugging Face models, …) goes into one folder, `cache` in
// the box's HOME, through each tool's own variable, so "never back up, cap, clean" becomes one rule for one folder. The
// box's HOME is /data on a personal Cloud and the audience's own engine home on a Team Cloud (server/engine-homes), so the
// folder is shared exactly as ~/.npm and ~/.cache already are, never across audiences.
//
// Only pure download caches move. Left alone on purpose: a variable whose folder also holds sign-ins, tokens, settings or
// installed programs (HF_HOME and XDG_CACHE_HOME, where Hugging Face keeps its login token; CARGO_HOME; GRADLE_USER_HOME;
// PNPM_HOME; UV_TOOL_DIR and UV_PYTHON_INSTALL_DIR, which venvs and ~/.local/bin point into), and pnpm's store, which a
// project's node_modules records (pnpm then refuses to install until node_modules is removed) and whose only variable,
// npm_config_store_dir, makes every npm command warn. Also left alone: PLAYWRIGHT_BROWSERS_PATH (older Playwright MCP builds
// keep the browser profile, with its cookies and site sign-ins, in that folder), PUPPETEER_CACHE_DIR (it beats a project's
// .puppeteerrc, so a project keeping Chrome in its own folder stops finding it) and GOMODCACHE (it beats `go env -w`, and a
// project building offline from its module cache would fail), COREPACK_HOME (its lastKnownGood.json records which
// package manager version is active, not only downloads) and GOCACHE (it also holds Go's fuzzing corpus, which
// `go clean -cache` keeps).
//
// The folder is used only when the server made it (ensureToolCacheRoot): it is marked with a CACHEDIR.TAG, and a `cache`
// folder already in HOME without that mark is the person's own, so for that HOME nothing is routed into it.
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cloudRole } from "./detect.ts";

/** The switch: 1, on, true or yes on a Cloud home turns the tool cache folder on; anything else, or unset, leaves it off. */
export const CACHE_ROOT_SWITCH = "OMB_CACHE_ROOT";

/** The folder in the box's HOME that the tools' caches go to. */
export const TOOL_CACHE_DIR = "cache";

/** The mark the server leaves in a cache folder it made (https://bford.info/cachedir/): backup tools skip a tagged folder,
 * and the cache cap (server/cache-sweep) works only in a folder with exactly this text. */
export const CACHE_TAG_FILE = "CACHEDIR.TAG";
export const CACHE_TAG = "Signature: 8a477f597d28d172789f06886806bc55\n# Made by OpenMausBot for its bots' tool caches (OMB_CACHE_ROOT). Everything here is downloaded again when missing.\n";

export interface ToolCache {
  /** The tool's own variable. */
  name: string;
  /** Its folder under the cache root. */
  folder: string;
  /** Variables that, set by the person or the engine, already decide where this cache goes: then it is left to them. */
  yieldsTo: readonly string[];
}

/** Every cache this moves, each a folder only the tool's own downloads are in. A variable here beats the tool's config files
 * (docs/bot-box.md says which): what that costs is a download again, never a sign-in or a project's own files. */
export const TOOL_CACHES: readonly ToolCache[] = [
  // npm reads its config from the environment in any letter case; npx keeps its packages in the same cache (_npx).
  { name: "npm_config_cache", folder: "npm", yieldsTo: [] },
  { name: "PIP_CACHE_DIR", folder: "pip", yieldsTo: ["XDG_CACHE_HOME"] },
  // uv's wheels and source builds only; the Pythons and tools it installs stay where venvs and ~/.local/bin find them.
  { name: "UV_CACHE_DIR", folder: "uv", yieldsTo: ["XDG_CACHE_HOME"] },
  // The models and datasets' files only: HF_HOME, which holds the login token, is never set here.
  { name: "HF_HUB_CACHE", folder: "huggingface/hub", yieldsTo: ["HF_HOME", "HUGGINGFACE_HUB_CACHE", "XDG_CACHE_HOME"] },
  { name: "HF_XET_CACHE", folder: "huggingface/xet", yieldsTo: ["HF_HOME", "XDG_CACHE_HOME"] },
  // bun's default follows BUN_INSTALL; it may also follow XDG_CACHE_HOME (not checked), so a person's value there wins too.
  { name: "BUN_INSTALL_CACHE_DIR", folder: "bun", yieldsTo: ["BUN_INSTALL", "XDG_CACHE_HOME"] },
];

const ON = new Set(["1", "on", "true", "yes"]);

/** Whether this server puts its bots' tool caches in the cache folder: a Cloud home with the switch on, never a desktop. */
export function toolCachesOn(env: Record<string, string | undefined>): boolean {
  return cloudRole(env) && ON.has((env[CACHE_ROOT_SWITCH] ?? "").trim().toLowerCase());
}

/** The cache folder of a box whose HOME is `home`. */
export function toolCacheRoot(home: string): string {
  return join(resolve(home), TOOL_CACHE_DIR);
}

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? "";

/** Whether `root` is a real folder (not a link) holding the server's own CACHEDIR.TAG. */
export function hasCacheTag(root: string): boolean {
  try {
    if (!lstatSync(root).isDirectory()) return false;
    const tag = join(root, CACHE_TAG_FILE);
    return lstatSync(tag).isFile() && readFileSync(tag, "utf8") === CACHE_TAG;
  } catch {
    return false;
  }
}

/** Makes the cache folder `root` when HOME has none, and marks it. True: the folder is the server's (made now, marked by
 * an earlier start, or an empty folder, which is marked now: a start that made it may have stopped before its mark).
 * False: a `cache` with something in it and no mark is the person's, so it is left alone. Null: it could not be made
 * now (HOME missing): ask again on the next spawn. Never deletes or changes anything already in a folder. */
export function ensureToolCacheRoot(root: string): boolean | null {
  try {
    mkdirSync(root, { mode: 0o755 });
  } catch (error) {
    if (code(error) !== "EEXIST") return null;
    if (hasCacheTag(root)) return true;
    if (!emptyFolder(root)) return false;
  }
  try {
    writeFileSync(join(root, CACHE_TAG_FILE), CACHE_TAG, { flag: "wx", mode: 0o644 });
    return true;
  } catch {
    return hasCacheTag(root);
  }
}

function emptyFolder(path: string): boolean {
  try { return lstatSync(path).isDirectory() && readdirSync(path).length === 0; } catch { return false; }
}

const named = (env: Readonly<Record<string, string | undefined>>) =>
  new Map(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "").map(([name, value]) => [name.toLowerCase(), value]));

/** The variables to add to a box's environment `env` (already allow-listed) whose HOME is `home`. `given` is what the
 * spawn was handed before the allow-list: on a Cloud home the server's own environment carries none of these names
 * (cloud-home-start.ts SERVER_ENV_NAMES), so one there is the person's or the engine's for this spawn. A cache whose
 * variable, or a variable that decides its place, either names is left to them; its own variable that the allow-list
 * dropped goes back with their value. Every other cache gets its folder in the cache root. */
export function toolCacheEnvironment(home: string, env: Readonly<Record<string, string | undefined>>, given: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  const kept = named(env), handed = named(given);
  const root = toolCacheRoot(home);
  const added: Record<string, string> = {};
  for (const cache of TOOL_CACHES) {
    const name = cache.name.toLowerCase();
    if (!kept.has(name) && handed.has(name)) added[cache.name] = handed.get(name)!;
    else if (![name, ...cache.yieldsTo.map((other) => other.toLowerCase())].some((other) => kept.has(other) || handed.has(other))) added[cache.name] = join(root, ...cache.folder.split("/"));
  }
  return added;
}
