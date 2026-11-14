// A headless Chrome presents exactly what the same binary reports when headed.
// The --user-agent flag alone empties the high-entropy client hints, and the CDP
// override alone leaves "HeadlessChrome" in service workers; only both, with
// the binary's own metadata on every page, frame and worker, agree everywhere
// (measured on Chrome 153).

export interface BrandVersion {
  brand: string;
  version: string;
}

/** Emulation.setUserAgentOverride's userAgentMetadata, as navigator.userAgentData reports it. */
export interface UserAgentMetadata {
  brands: BrandVersion[];
  fullVersionList: BrandVersion[];
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

export interface Identity {
  userAgent: string;
  userAgentMetadata: UserAgentMetadata;
  /** Browser.getVersion's product, e.g. "Chrome/153.0.8010.12". */
  product: string;
}

export interface IdentityOverride {
  userAgent: string;
  userAgentMetadata: UserAgentMetadata;
  acceptLanguage?: string;
}

/** Read in the isolated world: userAgentData exists only in a secure context, such as a loopback page. */
export const IDENTITY_PROBE = `(async () => ({
  userAgent: navigator.userAgent,
  high: await navigator.userAgentData.getHighEntropyValues(["brands", "fullVersionList", "platformVersion", "architecture", "bitness", "model", "uaFullVersion", "wow64", "formFactors", "mobile", "platform"]),
}))()`;

export interface IdentityProbe {
  userAgent: string;
  high: {
    brands?: BrandVersion[];
    fullVersionList?: BrandVersion[];
    uaFullVersion?: string;
    platform?: string;
    platformVersion?: string;
    architecture?: string;
    model?: string;
    mobile?: boolean;
    bitness?: string;
    wow64?: boolean;
    formFactors?: string[];
  };
}

export function headedUserAgent(userAgent: string): string {
  return userAgent.replace("HeadlessChrome/", "Chrome/");
}

export function identityFromProbe(probe: IdentityProbe, product: string): Identity {
  const high = probe.high;
  return {
    userAgent: headedUserAgent(probe.userAgent),
    userAgentMetadata: {
      brands: high.brands ?? [],
      fullVersionList: high.fullVersionList ?? [],
      fullVersion: high.uaFullVersion ?? "",
      platform: high.platform ?? "",
      platformVersion: high.platformVersion ?? "",
      architecture: high.architecture ?? "",
      model: high.model ?? "",
      mobile: high.mobile ?? false,
      bitness: high.bitness ?? "",
      wow64: high.wow64 ?? false,
      formFactors: high.formFactors ?? [],
    },
    product: product.replace("HeadlessChrome/", "Chrome/"),
  };
}

export function identityOverride(identity: Pick<Identity, "userAgent" | "userAgentMetadata">, acceptLanguage?: string): IdentityOverride {
  return {
    userAgent: identity.userAgent,
    userAgentMetadata: identity.userAgentMetadata,
    ...(acceptLanguage ? { acceptLanguage } : {}),
  };
}

/** Fields where two identities differ; empty when a page could not tell them apart. */
export function identityDifferences(a: Pick<Identity, "userAgent" | "userAgentMetadata">, b: Pick<Identity, "userAgent" | "userAgentMetadata">): string[] {
  const differences: string[] = [];
  if (a.userAgent !== b.userAgent) differences.push("userAgent");
  for (const key of Object.keys(a.userAgentMetadata) as Array<keyof UserAgentMetadata>) {
    if (JSON.stringify(a.userAgentMetadata[key]) !== JSON.stringify(b.userAgentMetadata[key])) differences.push(`userAgentMetadata.${key}`);
  }
  return differences;
}
