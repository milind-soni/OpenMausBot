// The connected apps a burger layer can name, with the site its icon comes from. Composio's own slugs, lowercase.
const APPS: Record<string, { label: string; domain: string }> = {
  gmail: { label: "Gmail", domain: "gmail.com" },
  googlecalendar: { label: "Google Calendar", domain: "calendar.google.com" },
  googlesheets: { label: "Google Sheets", domain: "sheets.google.com" },
  googledocs: { label: "Google Docs", domain: "docs.google.com" },
  googledrive: { label: "Google Drive", domain: "drive.google.com" },
  googleslides: { label: "Google Slides", domain: "slides.google.com" },
  slack: { label: "Slack", domain: "slack.com" },
  github: { label: "GitHub", domain: "github.com" },
  notion: { label: "Notion", domain: "notion.so" },
  linear: { label: "Linear", domain: "linear.app" },
  sentry: { label: "Sentry", domain: "sentry.io" },
  posthog: { label: "PostHog", domain: "posthog.com" },
  discord: { label: "Discord", domain: "discord.com" },
  twitter: { label: "X", domain: "x.com" },
  reddit: { label: "Reddit", domain: "reddit.com" },
  hubspot: { label: "HubSpot", domain: "hubspot.com" },
  salesforce: { label: "Salesforce", domain: "salesforce.com" },
  jira: { label: "Jira", domain: "atlassian.com" },
  asana: { label: "Asana", domain: "asana.com" },
  trello: { label: "Trello", domain: "trello.com" },
  dropbox: { label: "Dropbox", domain: "dropbox.com" },
  airtable: { label: "Airtable", domain: "airtable.com" },
  figma: { label: "Figma", domain: "figma.com" },
  stripe: { label: "Stripe", domain: "stripe.com" },
  outlook: { label: "Outlook", domain: "outlook.com" },
  microsoftteams: { label: "Microsoft Teams", domain: "teams.microsoft.com" },
  zoom: { label: "Zoom", domain: "zoom.us" },
};

/** The plain app tool names bots call on every engine (gmail.search_emails, or gmail_search_emails where a dot is refused). */
export const PLAIN_APP_TOOL = /^(gmail|googlecalendar|googlesheets|googledocs|googledrive|slack|github|notion|linear)[._]([a-z][a-z0-9_]*)$/;

/** Composio's logo for one of its apps, by slug. */
const logoOf = (slug: string) => `https://logos.composio.dev/api/${encodeURIComponent(slug.toLowerCase())}`;

export function appMeta(slug: string): { label: string; domain: string | null; logo: string } {
  const known = APPS[slug.toLowerCase()];
  if (known) return { ...known, logo: logoOf(slug) };
  const words = slug.replace(/[_-]+/g, " ").trim();
  return { label: words ? words[0]!.toUpperCase() + words.slice(1) : slug, domain: null, logo: logoOf(slug) };
}

/** An app action that names no thing ("batch get", "list"): it reads from the app. */
export const BARE_READ = /^(?:batch |bulk )?(?:get|read|fetch|list|query|search|lookup|retrieve)$/;
