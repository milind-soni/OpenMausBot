// The handful of outward links the app offers from the profile menu and the
// About dialog. They are collected here so "where does Help go?" has one
// answer rather than one per call site.
export const APP_NAME = "OpenMausBot";
export const APP_REPOSITORY = "https://github.com/milind-soni/OpenMausBot";
/** The docs tree is the help centre, and it is where openmausbot.com sends
 * people too — one destination, not two competing ones. */
export const DOCS_URL = `${APP_REPOSITORY}/tree/main/docs`;
export const HELP_CENTER_URL = DOCS_URL;
export const APPROVAL_LEVELS_URL = `${APP_REPOSITORY}/blob/main/docs/approval-levels.md`;
/** Feedback goes to the community rather than the issue tracker: most of it
 * is a question or a "does anyone else see this", and those get an answer in
 * Discord in minutes instead of sitting open as an issue. */
export const FEEDBACK_URL = "https://discord.gg/9Wb8MEpXRs";
export const RELEASES_URL = `${APP_REPOSITORY}/releases`;
export const LICENSE_URL = `${APP_REPOSITORY}/blob/main/LICENSE`;

/** The version Vite inlined from package.json; "dev" when the define is
 * missing (a bare `tsc`/test run outside the bundler). */
export function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/** "macOS", "Windows", "Linux" — or nothing at all in the browser, where the
 * host OS is not ours to claim. */
export function platformLabel(platform?: string): string | null {
  return (platform && PLATFORM_NAMES[platform]) ?? null;
}

/** Hands a link to the default browser through the preload bridge, falling
 * back to a new tab when the app runs in a plain browser. */
export async function openExternalLink(url: string): Promise<void> {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
