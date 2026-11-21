// The Chrome policy that keeps a person on the browser desktop away from this computer's files, Chrome's own pages and
// DevTools. It applies only to a Chrome launched on a private display: that Chrome starts inside its own mount namespace
// (bubblewrap) where each brand's managed-policy folder holds this policy, so every other Chrome on the computer, the
// bots' headless ones included, reads its folders as they are. Chrome reads policy from a folder per brand: Chromium's
// chrome_paths.cc, and Chrome for Testing 158's binary names /etc/opt/chrome_for_testing/policies.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Pages a person may still open from Chrome's own address bar: the new tab page. */
const ALLOWED_CHROME_PAGES = ["chrome://newtab", "chrome://new-tab-page", "chrome://new-tab-page-third-party"];

/** The policy, with `fileRoots` (absolute folders) the one exception to the block on files. */
export function desktopPolicy(fileRoots: readonly string[] = []): Record<string, unknown> {
  return {
    URLBlocklist: ["file://*", "chrome://*", "devtools://*", "view-source:*"],
    URLAllowlist: [...ALLOWED_CHROME_PAGES, ...fileRoots.map((root) => `file://${root.replace(/\/+$/u, "")}/`)],
    // DeveloperToolsAvailability 2 would also stop DevTools Protocol clients attaching to pages (Chromium 156), and the
    // bots drive Chrome through that protocol: DevTools is kept out by its address and its keys (rfb-filter.ts).
    BrowserGuestModeEnabled: false,
    BrowserAddPersonEnabled: false,
    IncognitoModeAvailability: 1,
    BrowserSignin: 0,
    SyncDisabled: true,
    AllowFileSelectionDialogs: false,
    PromptForDownloadLocation: false,
    TaskManagerEndProcessEnabled: false,
    DefaultBrowserSettingEnabled: false,
    // Google Chrome's own first-run screens (the ad privacy notice, What's new and other promotions) would sit over the
    // page a person sees on the display, as no headless Chrome shows them.
    PrivacySandboxPromptEnabled: false,
    PromotionsEnabled: false,
  };
}

/** Each brand's managed-policy folder, and the folder above it that a private tmpfs replaces to put the policy there. */
const BRANDS = [
  { managed: "/etc/opt/chrome/policies/managed", covered: "/etc/opt" },
  { managed: "/etc/opt/chrome_for_testing/policies/managed", covered: "/etc/opt" },
  { managed: "/etc/chromium/policies/managed", covered: "/etc/chromium/policies" },
] as const;

export interface PolicyWrap {
  command: string;
  /** bubblewrap's own arguments; Chrome's command line follows. */
  args: string[];
}

/** Writes the policy into `dir` and answers the command that starts Chrome with only that policy in force. */
export function policyWrap(bwrap: string, dir: string, fileRoots: readonly string[] = [], exists: (path: string) => boolean = existsSync): PolicyWrap {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "openmausbot.json"), `${JSON.stringify(desktopPolicy(fileRoots), null, 2)}\n`, { mode: 0o600 });
  const args = ["--dev-bind", "/", "/", "--die-with-parent"];
  const covered = new Set<string>();
  for (const brand of BRANDS) {
    // A brand whose own folder is absent is not installed here. Security: any other folder that cannot be covered makes
    // bubblewrap fail, so that Chrome does not start at all rather than start without the policy.
    if (brand.covered !== "/etc/opt" && !exists(brand.managed.slice(0, brand.managed.indexOf("/policies")))) continue;
    if (!covered.has(brand.covered)) {
      args.push("--tmpfs", brand.covered);
      covered.add(brand.covered);
    }
    args.push("--ro-bind", dir, brand.managed);
  }
  return { command: bwrap, args: [...args, "--"] };
}

/** bubblewrap on PATH, if it can make the private mount namespace here (a container may refuse user namespaces). */
export function findBwrap(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "linux") return null;
  for (const folder of (env.PATH ?? "").split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, "bwrap");
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    try {
      execFileSync(candidate, ["--dev-bind", "/", "/", "--tmpfs", "/etc/opt", "--", "/bin/true"], { stdio: "ignore", timeout: 10_000 });
      return candidate;
    } catch {
      return null;
    }
  }
  return null;
}
