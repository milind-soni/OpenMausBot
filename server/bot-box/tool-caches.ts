// Tool caches on a Cloud home (docs/bot-box.md, "Tool caches"). With OMB_CACHE_ROOT on, what a bot's tools download again
// whenever it is missing (npm's and pip's packages, uv's wheels, Playwright's browsers, Hugging Face models, …) goes into
// one folder, `cache` in the box's HOME, through each tool's own variable, so "never back up, cap, clean" becomes one rule
// for one folder. The box's HOME is /data on a personal Cloud and the audience's own engine home on a Team Cloud
// (server/engine-homes), so the folder is shared exactly as ~/.npm and ~/.cache already are, never across audiences.
//
// Only pure download caches move. Left alone on purpose: a variable whose folder also holds sign-ins, tokens, settings or
// installed programs (HF_HOME and XDG_CACHE_HOME, where Hugging Face keeps its login token; CARGO_HOME; GRADLE_USER_HOME;
// PNPM_HOME; UV_TOOL_DIR and UV_PYTHON_INSTALL_DIR, which venvs and ~/.local/bin point into), and pnpm's store, which a
// project's node_modules records (pnpm then refuses to install until node_modules is removed) and whose only variable,
// npm_config_store_dir, makes every npm command warn.
import { join, resolve } from "node:path";

import { cloudRole } from "./detect.ts";

/** The switch: 1, on, true or yes on a Cloud home turns the tool cache folder on; anything else, or unset, leaves it off. */
export const CACHE_ROOT_SWITCH = "OMB_CACHE_ROOT";

/** The folder in the box's HOME that the tools' caches go to. */
export const TOOL_CACHE_DIR = "cache";

export interface ToolCache {
  /** The tool's own variable. */
  name: string;
  /** Its folder under the cache root. */
  folder: string;
  /** Variables that, set by the person or the engine, already decide where this cache goes: then it is left to them. */
  yieldsTo: readonly string[];
}

/** Every cache this moves, each a folder only the tool's own downloads are in. */
export const TOOL_CACHES: readonly ToolCache[] = [
  // npm reads its config from the environment in any letter case; npx keeps its packages in the same cache (_npx).
  { name: "npm_config_cache", folder: "npm", yieldsTo: [] },
  { name: "PIP_CACHE_DIR", folder: "pip", yieldsTo: ["XDG_CACHE_HOME"] },
  // uv's wheels and source builds only; the Pythons and tools it installs stay where venvs and ~/.local/bin find them.
  { name: "UV_CACHE_DIR", folder: "uv", yieldsTo: ["XDG_CACHE_HOME"] },
  { name: "PLAYWRIGHT_BROWSERS_PATH", folder: "ms-playwright", yieldsTo: ["XDG_CACHE_HOME"] },
  // Puppeteer's default is ~/.cache/puppeteer whatever XDG_CACHE_HOME says.
  { name: "PUPPETEER_CACHE_DIR", folder: "puppeteer", yieldsTo: [] },
  // The models and datasets' files only: HF_HOME, which holds the login token, is never set here.
  { name: "HF_HUB_CACHE", folder: "huggingface/hub", yieldsTo: ["HF_HOME", "HUGGINGFACE_HUB_CACHE", "XDG_CACHE_HOME"] },
  { name: "HF_XET_CACHE", folder: "huggingface/xet", yieldsTo: ["HF_HOME", "XDG_CACHE_HOME"] },
  { name: "BUN_INSTALL_CACHE_DIR", folder: "bun", yieldsTo: ["BUN_INSTALL"] },
  // The package managers' own copies corepack downloads.
  { name: "COREPACK_HOME", folder: "corepack", yieldsTo: ["XDG_CACHE_HOME"] },
  { name: "GOCACHE", folder: "go-build", yieldsTo: ["XDG_CACHE_HOME"] },
  { name: "GOMODCACHE", folder: "go-mod", yieldsTo: ["GOPATH"] },
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

/** The variables to add to a box's environment `env` (already allow-listed) whose HOME is `home`: each cache's, unless
 * `env` already names it (the person's own value, which passed the box as theirs) or names what decides it. */
export function toolCacheEnvironment(home: string, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const set = new Set(Object.keys(env).filter((name) => env[name] !== undefined && env[name] !== "").map((name) => name.toLowerCase()));
  const root = toolCacheRoot(home);
  const added: Record<string, string> = {};
  for (const cache of TOOL_CACHES) {
    if ([cache.name, ...cache.yieldsTo].some((name) => set.has(name.toLowerCase()))) continue;
    added[cache.name] = join(root, ...cache.folder.split("/"));
  }
  return added;
}
