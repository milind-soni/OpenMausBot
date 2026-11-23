import product from "../product.json" with { type: "json" };

/**
 * Hosted services this build talks to, from product.json's "services". null is off: the feature says it is not
 * available and nothing is sent. This fork runs none of upstream's services, so every one is null.
 */
export interface Services {
  /** PostHog project for usage analytics. */
  analytics: { token: string; host: string } | null;
  /** Origin of the hosted Cloud: accounts, plans, Cloud homes, the included services. */
  cloud: string | null;
  /** Origin of the companion account service the phone relay is reached through. */
  accounts: string | null;
  /** Origin of the organization admin portal. */
  adminPortal: string | null;
  /** The managed Composio broker; a person's own Composio key works without it. */
  composioBroker: string | null;
  /** Origin that takes problem reports for the team that builds the app. */
  problemReports: string | null;
  /** Raw base URL of the in-app announcements feed. */
  announcements: string | null;
  /** URL of the model manifest that refreshes the bundled model lists. */
  modelManifest: string | null;
  /** Repository the shared team library is read from. */
  teamLibrary: { repository: string; rawRoot: string } | null;
}

export const SERVICES: Services = product.services as Services;

/** This build's own source repository, for links to its docs and releases. */
export const REPOSITORY_URL = `https://github.com/${product.updates.owner}/${product.updates.repo}`;

/** A doc in this build's own repository. */
export function repositoryDoc(path: string): string {
  return `${REPOSITORY_URL}/blob/main/${path}`;
}
