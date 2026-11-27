/** The Composio apps Connected apps lists when the catalog cannot be read. Product analytics names these apps, and only these. */
export const CURATED_CONNECTOR_SLUGS = [
  "slack", "github", "gmail", "googlecalendar", "googlesheets", "googledocs", "googledrive", "notion", "linear", "sentry",
  "posthog", "discord", "twitter", "reddit", "zapier", "hubspot", "salesforce", "jira", "asana", "trello", "dropbox",
  "airtable", "figma", "stripe",
] as const;

export type CuratedConnectorSlug = (typeof CURATED_CONNECTOR_SLUGS)[number];
