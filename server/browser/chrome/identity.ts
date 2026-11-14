// A headless Chrome tells pages it is headless only through "HeadlessChrome/" in its user agent; everything else it reports
// is what the same binary reports headed. So the identity is read from the binary itself, once per version, and only that
// token changes. The user-agent flag alone empties the high-entropy client hints, and a CDP override alone leaves
// HeadlessChrome in service workers, so the browser gets both (Chrome 153, measured).
import { existsSync } from "node:fs";

export interface Brand { brand: string; version: string }

/** CDP's Emulation.UserAgentMetadata. */
export interface UserAgentMetadata {
  brands: Brand[];
  fullVersionList: Brand[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
  formFactors: string[];
}

export interface ChromeIdentity { userAgent: string; userAgentMetadata: UserAgentMetadata }

export const HIGH_ENTROPY_HINTS = ["architecture", "bitness", "brands", "formFactors", "fullVersionList", "mobile", "model", "platform", "platformVersion", "uaFullVersion", "wow64"] as const;

function brands(value: unknown, what: string): Brand[] {
  if (!Array.isArray(value) || !value.length || !value.every((entry) => typeof entry?.brand === "string" && typeof entry?.version === "string")) {
    throw new Error(`the browser reported no ${what}`);
  }
  return value.map(({ brand, version }) => ({ brand, version }));
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`the browser reported no ${what}`);
  return value;
}

/** What a headless launch read, as that binary reports it headed. A build that names itself headless anywhere else, such as
 * the headless shell, cannot be made to look like Chrome and is refused. */
export function headedIdentity(read: { userAgent: unknown; hints: Record<string, unknown> | null | undefined }): ChromeIdentity {
  const userAgent = text(read.userAgent, "user agent").replace("HeadlessChrome/", "Chrome/");
  if (!/ Chrome\/\d+\.0\.0\.0 /u.test(userAgent) || /headless/iu.test(userAgent)) throw new Error(`the browser's user agent is not Chrome's: ${userAgent}`);
  const hints = read.hints ?? {};
  const metadata: UserAgentMetadata = {
    brands: brands(hints.brands, "brands"),
    fullVersionList: brands(hints.fullVersionList, "full version list"),
    fullVersion: text(hints.uaFullVersion, "full version"),
    platform: text(hints.platform, "platform"),
    platformVersion: text(hints.platformVersion, "platform version"),
    architecture: text(hints.architecture, "architecture"),
    model: text(hints.model, "model"),
    mobile: hints.mobile === true,
    bitness: text(hints.bitness, "bitness"),
    wow64: hints.wow64 === true,
    formFactors: Array.isArray(hints.formFactors) ? hints.formFactors.filter((value): value is string => typeof value === "string") : [],
  };
  if ([...metadata.brands, ...metadata.fullVersionList].some(({ brand }) => /headless/iu.test(brand))) throw new Error("the browser reports a headless brand");
  return { userAgent, userAgentMetadata: metadata };
}

export function isChromeIdentity(value: unknown): value is ChromeIdentity {
  try {
    const identity = value as ChromeIdentity;
    const again = headedIdentity({ userAgent: identity.userAgent, hints: { ...identity.userAgentMetadata, uaFullVersion: identity.userAgentMetadata.fullVersion } });
    return JSON.stringify(again) === JSON.stringify(identity);
  } catch {
    return false;
  }
}

/** agent-browser 0.37 adds --no-sandbox in these same places; a sandboxed Chrome cannot start there. */
export function needsNoSandbox(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): boolean {
  if (process.platform !== "linux") return false;
  return exists("/.dockerenv") || exists("/run/.containerenv") || process.getuid?.() === 0 || Boolean(env.CI);
}
