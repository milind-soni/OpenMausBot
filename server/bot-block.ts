// Recognising the page that means "you are not getting through this one".
//
// A browsing agent that lands on a Cloudflare interstitial or a bot-check
// frame does not know it is stuck: it screenshots, sees a page, tries again,
// and burns the turn. The harness can tell cheaply, from the URL and title
// the browser tools already return — so it tells the agent to stop and hand
// the wheel to the user, which is what the system prompt already asks for at
// a sign-in or CAPTCHA step.
//
// `high` changes the tool result and notifies. `low` only records: a
// reCAPTCHA frame is usually embedded in a page the agent CAN use, and a
// page titled "Access Denied" is occasionally a real 403 someone meant to
// visit. Interrupting a person over either is worse than missing it.
//
// This is a signature table, so it dates. Adding a family is one entry plus
// one row in the test's `blocked` list — keep it that cheap.
type Match = {
  equals?: string[];
  suffix?: string[];
  prefix?: string[];
  includes?: string[];
  startsWith?: string[];
};

export interface BlockSignature {
  family: string;
  confidence: "high" | "low";
  host?: Match;
  path?: Match;
  title?: Match;
}

export const BLOCK_SIGNATURES: BlockSignature[] = [
  { family: "google_sorry", confidence: "high", host: { equals: ["google.com"], suffix: [".google.com"] }, path: { prefix: ["/sorry"] } },
  { family: "google_signin_rejected", confidence: "high", host: { equals: ["accounts.google.com"] }, path: { includes: ["/signin/rejected"] } },
  { family: "cloudflare_challenge", confidence: "high", host: { equals: ["challenges.cloudflare.com"] } },
  { family: "cloudflare_challenge", confidence: "high", path: { includes: ["/cdn-cgi/challenge-platform/"] } },
  { family: "cloudflare_challenge", confidence: "high", title: { startsWith: ["Just a moment", "Attention Required! | Cloudflare"] } },
  { family: "arkose", confidence: "high", host: { suffix: [".arkoselabs.com", ".funcaptcha.com"] } },
  { family: "datadome", confidence: "high", host: { equals: ["captcha-delivery.com", "captcha.datadome.co"], suffix: [".captcha-delivery.com"] } },
  { family: "perimeterx", confidence: "high", path: { includes: ["/px/captcha"] } },
  { family: "perimeterx", confidence: "high", host: { suffix: [".px-cloud.net"] } },
  { family: "perimeterx", confidence: "high", title: { equals: ["Access to this page has been denied"] } },
  { family: "imperva", confidence: "high", path: { includes: ["/_Incapsula_Resource"] } },
  { family: "aws_waf", confidence: "high", host: { suffix: [".token.awswaf.com"] } },
  { family: "linkedin_checkpoint", confidence: "high", host: { equals: ["linkedin.com"], suffix: [".linkedin.com"] }, path: { prefix: ["/checkpoint/challenge"] } },
  { family: "vercel_checkpoint", confidence: "high", title: { startsWith: ["Vercel Security Checkpoint"] } },
  { family: "vercel_checkpoint", confidence: "high", path: { includes: ["/.well-known/vercel/security/"] } },
  { family: "distil", confidence: "high", title: { equals: ["Pardon Our Interruption"] } },
  { family: "recaptcha", confidence: "low", path: { includes: ["/recaptcha/api2/", "/recaptcha/enterprise/"] } },
  { family: "hcaptcha", confidence: "low", host: { equals: ["hcaptcha.com"], suffix: [".hcaptcha.com"] } },
  { family: "generic_access_denied", confidence: "low", title: { equals: ["Access Denied"] } },
];

export interface BlockHit {
  family: string;
  confidence: "high" | "low";
  /** The host that did the blocking, www-stripped — the key a caller
   * rate-limits its takeover notifications on. */
  host: string;
}

/** An absent clause means "this signature does not care", so it matches.
 * A present-but-empty clause would too, which is why signatures never
 * carry one. */
function matches(clause: Match | undefined, value: string): boolean {
  if (!clause) return true;
  return (
    (clause.equals?.includes(value) ?? false) ||
    (clause.suffix?.some((s) => value.endsWith(s)) ?? false) ||
    (clause.prefix?.some((s) => value.startsWith(s)) ?? false) ||
    (clause.includes?.some((s) => value.includes(s)) ?? false) ||
    (clause.startsWith?.some((s) => value.startsWith(s)) ?? false)
  );
}

export function classifyBlockPage(page: { url: string; title?: string }): BlockHit | undefined {
  if (!URL.canParse(page.url)) return undefined;
  const parsed = new URL(page.url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const title = (page.title ?? "").trim();
  for (const signature of BLOCK_SIGNATURES) {
    // a signature with no clauses would match every page — refuse it rather
    // than trusting the table to never grow one
    if (!signature.host && !signature.path && !signature.title) continue;
    if (
      matches(signature.host, host) &&
      matches(signature.path, parsed.pathname) &&
      matches(signature.title, title)
    ) {
      return { family: signature.family, confidence: signature.confidence, host };
    }
  }
  return undefined;
}

/** What the agent is told instead of the page. The instruction to stop is
 * the point: an agent that retries a challenge is an agent spending the
 * user's tokens on a wall. */
export function blockedToolNote(hit: BlockHit): string {
  return [
    `This page is an anti-bot challenge (${hit.family} on ${hit.host}), not the content you asked for.`,
    "Do not retry it and do not try to solve it.",
    "Stop here and ask the user to open the computer and get past it themselves, then continue once they say it is done.",
  ].join(" ");
}

/** How long one host stays "already asked about". A blocked agent retries,
 * and each retry is another hit — without this the person gets a stream of
 * takeover buzzes for one wall. */
export const BLOCK_HELP_WINDOW_MS = 10 * 60 * 1_000;

export interface BlockHelpGate {
  /** True the first time this host blocks us, and again once the window
   * has passed — the person may have walked away from the first ask. */
  shouldAsk(host: string): boolean;
}

export function createBlockHelpGate(now: () => number = Date.now): BlockHelpGate {
  const askedAt = new Map<string, number>();
  return {
    shouldAsk(host: string): boolean {
      const at = now();
      const last = askedAt.get(host);
      if (last !== undefined && at - last <= BLOCK_HELP_WINDOW_MS) return false;
      askedAt.set(host, at);
      return true;
    },
  };
}
