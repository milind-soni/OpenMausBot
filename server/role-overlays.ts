export interface RoleOverlay {
  id: string;
  label: string;
  summary: string;
  capabilityQueries: string[];
  instructions: string;
  keywords: string[];
}

/** Small, non-privileged role lenses for the product portfolio. They do not
 * grant tools or approval authority; they only improve task routing and tell
 * the agent which capability metadata to look up lazily. */
export const ROLE_OVERLAYS: readonly RoleOverlay[] = [
  {
    id: "ios-engineer",
    label: "iOS Engineer",
    summary: "Swift, SwiftUI/UIKit, Xcode, simulator, device, and release-aware implementation.",
    capabilityQueries: ["ios ui debug", "ios github finish", "app store fleet release", "cupertino xcode"],
    instructions:
      "For Apple-platform work, separate source, focused tests, simulator or device proof, commerce, TestFlight, and release status. Preserve shared Xcode resources and search the fleet index for the smallest iOS specialist before acting.",
    keywords: ["ios", "iphone", "ipad", "swift", "swiftui", "uikit", "xcode", "testflight", "app store", "revenuecat"],
  },
  {
    id: "web-extension-engineer",
    label: "Web and Extension Engineer",
    summary: "Websites, browser extensions, frontend behavior, accessibility, and browser verification.",
    capabilityQueries: ["debug web ui", "browser control", "chrome control", "playwright", "cloudflare pages"],
    instructions:
      "For websites and browser extensions, reproduce the exact browser surface, preserve console and network evidence, test the affected viewport and interaction, and keep source, deployment, DNS, indexing, and store publication as separate claims.",
    keywords: ["website", "web app", "frontend", "react", "next.js", "css", "chrome extension", "browser extension", "manifest v3", "cloudflare"],
  },
  {
    id: "qa-acceptance",
    label: "QA and Acceptance",
    summary: "Exact-surface regression, acceptance receipts, and claim calibration.",
    capabilityQueries: ["pre claim verify", "peer verify", "acceptance", "screenshot", "sentry"],
    instructions:
      "Act as the acceptance owner: reproduce the reported surface, define observable pass conditions, run deterministic checks, retain redacted proof, and never upgrade configured or invoked state into verified, accepted, or live state.",
    keywords: ["qa", "quality", "acceptance", "regression", "verify", "test", "proof", "receipt", "bug", "broken"],
  },
  {
    id: "source-closeout",
    label: "Source Closeout",
    summary: "Dirty-tree-safe Git, GitHub, PR readiness, and unfinished-work reconciliation.",
    capabilityQueries: ["portfolio source closeout", "github closeout", "verified bugfix publish", "ios github finish"],
    instructions:
      "For source closeout, inspect ownership and exact repository state first, preserve dirty owner work, isolate changes, stage only owned paths, and report local source, remote branch, checks, review, merge, and release as distinct gates.",
    keywords: ["git", "github", "pull request", "pr", "branch", "commit", "merge", "worktree", "source closeout", "issue"],
  },
  {
    id: "memory-improvement-steward",
    label: "Memory and Improvement Steward",
    summary: "Proposal-only self-improvement and governed durable knowledge closeout.",
    capabilityQueries: ["config improvement loop", "memory graph governance", "bug to memory", "fleet memory sync"],
    instructions:
      "For memory and self-improvement work, observe and propose first, use the single governed writer for approved durable deltas, keep Hindsight and Obsidian acceptance separate, and never let a proposal loop promote configuration or releases by itself.",
    keywords: ["memory", "hindsight", "obsidian", "self improve", "self-improvement", "improvement loop", "lesson", "retrospective", "rag"],
  },
] as const;

function normalizedTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9.+#-]+/)
    .filter((token) => token.length > 1);
}

function overlayScore(overlay: RoleOverlay, text: string): number {
  const haystack = text.toLowerCase();
  const tokens = new Set(normalizedTokens(text));
  let score = 0;
  for (const keyword of overlay.keywords) {
    const normalized = keyword.toLowerCase();
    if (normalized.includes(" ") ? haystack.includes(normalized) : tokens.has(normalized)) {
      score += normalized.includes(" ") ? 4 : 2;
    }
  }
  if (haystack.includes(overlay.label.toLowerCase())) score += 8;
  return score;
}

export function suggestRoleOverlays(text: string, limit = 3): Array<Omit<RoleOverlay, "keywords" | "instructions">> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 1, 1), ROLE_OVERLAYS.length);
  return ROLE_OVERLAYS
    .map((overlay, index) => ({ overlay, index, score: overlayScore(overlay, text) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, boundedLimit)
    .map(({ overlay }) => ({
      id: overlay.id,
      label: overlay.label,
      summary: overlay.summary,
      capabilityQueries: [...overlay.capabilityQueries],
    }));
}

export function renderRoleOverlayInstructions(text: string, limit = 2): string {
  const ids = new Set(suggestRoleOverlays(text, limit).map((overlay) => overlay.id));
  const selected = ROLE_OVERLAYS.filter((overlay) => ids.has(overlay.id));
  if (!selected.length) return "";
  return `\nTask role overlays (guidance only; no added authority): ${selected
    .map((overlay) => `${overlay.label}: ${overlay.instructions}`)
    .join(" ")}`;
}
