// Ported from T3 Code's apps/server/src/preview/PreviewBrowserHost.ts,
// Copyright 2026 T3 Tools Inc., used under the MIT License
// (third_party/t3-code/LICENSE). Modified: plain TypeScript instead of Effect,
// OMB's command and environment names, and an AppArmor profile pinned to one
// exact executable instead of a wildcard path.
//
// OMB never turns Chrome's sandbox off by itself on a host. A host that cannot
// give it one gets the manual setup steps instead, and only an operator's explicit
// OMB_BROWSER_SANDBOX=0 launches without it. The computer container image (also
// run on a VPS) is the exception: it drops capabilities, so its Chrome runs
// without its own sandbox and the container is the isolation boundary.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Installs the Linux libraries Chrome needs (as root, once). */
export const LIBRARIES_COMMAND = "sudo openmausbot browser install --with-deps";
/** There is no command for the sandbox: an administrator allows one root-owned Chrome by hand. */
export const SANDBOX_STEPS_URL = "https://github.com/milind-soni/OpenMausBot/blob/main/docs/deploy-vps.md#ubuntu-2404-browser-sandbox";

/** What Chrome prints before aborting when it cannot sandbox itself. */
export const NO_SANDBOX_SIGNATURE = "No usable sandbox";

export function sandboxDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.OMB_BROWSER_SANDBOX === "0";
}

/** Set on Ubuntu 23.10+: unprivileged user namespaces need an AppArmor profile. */
export const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
export const APPARMOR_PROFILE_NAME = "openmausbot-chrome";
export const APPARMOR_PROFILE_PATH = `/etc/apparmor.d/${APPARMOR_PROFILE_NAME}`;

/**
 * Lets exactly one root-owned Chrome create the user namespace its sandbox runs
 * in, modelled on the profile Ubuntu ships for Google Chrome. A path a user can
 * write, or a pattern, would let any program claim the exemption.
 */
export function appArmorProfile(executable: string): string {
  if (!isAbsolute(executable) || /[\s*?[\]{}"'\\^]/.test(executable) || !executable.startsWith("/opt/")) {
    throw new Error(`The browser's AppArmor exemption is only for a root-owned path under /opt, not ${executable}.`);
  }
  return `# Written for OpenMausBot: lets its Chrome use its sandbox.
abi <abi/4.0>,
include <tunables/global>

profile ${APPARMOR_PROFILE_NAME} ${executable} flags=(unconfined) {
  userns,

  include if exists <local/${APPARMOR_PROFILE_NAME}>
}
`;
}

/**
 * Chrome's Debian dependencies that minimal images leave out, plus fonts so
 * pages do not render as boxes. Ubuntu 24.04 and Debian 13 renamed some with a
 * `t64` suffix; setup installs whichever name the host's apt offers.
 */
export const DEBIAN_PACKAGES: ReadonlyArray<ReadonlyArray<string>> = [
  ["libnss3"],
  ["libglib2.0-0t64", "libglib2.0-0"],
  ["libatk1.0-0t64", "libatk1.0-0"],
  ["libatk-bridge2.0-0t64", "libatk-bridge2.0-0"],
  ["libatspi2.0-0t64", "libatspi2.0-0"],
  ["libdbus-1-3"],
  ["libx11-6"],
  ["libxcb1"],
  ["libxcomposite1"],
  ["libxdamage1"],
  ["libxext6"],
  ["libxfixes3"],
  ["libxrandr2"],
  ["libxkbcommon0"],
  ["libgbm1"],
  ["libasound2t64", "libasound2"],
  ["libexpat1"],
  ["fonts-liberation"],
  ["fonts-noto-color-emoji"],
  ["fonts-noto-cjk"],
];

export class BrowserHostError extends Error {
  readonly kind: "sandbox" | "libraries";
  readonly libraries: readonly string[];

  constructor(kind: "sandbox" | "libraries", libraries: readonly string[] = []) {
    super(kind === "sandbox"
      ? `This host blocks the sandbox the browser runs in (AppArmor on Ubuntu 23.10+). An administrator can allow it for one root-owned copy of Chrome, following ${SANDBOX_STEPS_URL}, then try again.`
      : `This host is missing libraries the browser needs (${libraries.join(", ")}). Run \`${LIBRARIES_COMMAND}\` on the host to install them, then try again.`);
    this.name = "BrowserHostError";
    this.kind = kind;
    this.libraries = libraries;
  }
}

const MISSING_LIBRARY = /^\s*(\S+) => not found$/gm;
/** glibc's loader abort, naming the first library it could not load. */
const LOADER_ERROR = /error while loading shared libraries: ([^:\s]+)/;

/** The library glibc's loader names in a failed launch's output, if any. */
export function loaderMissingLibrary(output: string): string | undefined {
  return LOADER_ERROR.exec(output)?.[1];
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 5_000, encoding: "utf8", windowsHide: true, env }, (_error, stdout, stderr) => resolve(`${stdout ?? ""}${stderr ?? ""}`));
  });
}

/**
 * Shared libraries the loader cannot find, with the environment the browser
 * was launched in. The browser's own `--version` decides whether any are
 * missing; `ldd` only lists them after the loader fails, because it can report
 * libraries a host provides another way (NixOS's nix-ld).
 */
export async function missingLibraries(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const loaderError = loaderMissingLibrary(await run(executable, ["--version"], env));
  if (loaderError === undefined) return [];
  const listed = [...(await run("ldd", [executable], env)).matchAll(MISSING_LIBRARY)].map((match) => match[1]!);
  return listed.length > 0 ? listed : [loaderError];
}

/** After a launch fails, the host setup it is missing, or null when neither explains it. */
export async function diagnoseLaunchFailure(input: { executable: string; output: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): Promise<BrowserHostError | null> {
  if (input.output.includes(NO_SANDBOX_SIGNATURE)) return new BrowserHostError("sandbox");
  if ((input.platform ?? process.platform) !== "linux") return null;
  const libraries = await missingLibraries(input.executable, input.env);
  return libraries.length ? new BrowserHostError("libraries", libraries) : null;
}

/** Whether the sandbox will be blocked here: user namespaces are restricted and the profile is not installed. Readable without root. */
export function sandboxBlocked({ platform = process.platform, read = (path: string) => readFileSync(path, "utf8"), exists = existsSync }: {
  platform?: NodeJS.Platform;
  read?: (path: string) => string;
  exists?: (path: string) => boolean;
} = {}): boolean {
  if (platform !== "linux") return false;
  let restricted = false;
  try { restricted = read(USERNS_RESTRICTION).trim() === "1"; } catch {}
  return restricted && !exists(APPARMOR_PROFILE_PATH);
}
