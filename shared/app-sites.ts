// Which connected app a website belongs to, so a sign-in on that site can offer the app instead. The catalogue lists no
// sites, so this table names them. Matching is by the site's registrable domain only: a domain shared by several apps
// (google.com, microsoft.com) offers none, and a lookalike (github.com.example.net) is its own domain.
import { loginSite } from "./logins.ts";

/** Registrable domain → catalogue slug. */
export const APP_SITES: Readonly<Record<string, string>> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "notion.so": "notion",
  "notion.com": "notion",
  "linear.app": "linear",
  "slack.com": "slack",
  "sentry.io": "sentry",
  "posthog.com": "posthog",
  "discord.com": "discord",
  "reddit.com": "reddit",
  "zapier.com": "zapier",
  "hubspot.com": "hubspot",
  "salesforce.com": "salesforce",
  "atlassian.net": "jira",
  "asana.com": "asana",
  "trello.com": "trello",
  "dropbox.com": "dropbox",
  "airtable.com": "airtable",
  "figma.com": "figma",
  "stripe.com": "stripe",
  "shopify.com": "shopify",
  "mailchimp.com": "mailchimp",
  "zoom.us": "zoom",
  "x.com": "twitter",
  "twitter.com": "twitter",
  "clickup.com": "clickup",
  "monday.com": "monday",
  "intercom.com": "intercom",
  "zendesk.com": "zendesk",
  "calendly.com": "calendly",
  "typeform.com": "typeform",
  "webflow.com": "webflow",
  "vercel.com": "vercel",
  "supabase.com": "supabase",
  "canva.com": "canva",
  "miro.com": "miro",
  "todoist.com": "todoist",
  "pipedrive.com": "pipedrive",
  "box.com": "box",
};

/** The catalogue slug for a site's address or host, or null when no single app owns its registrable domain. */
export function appForSite(site: string | null | undefined): string | null {
  if (!site) return null;
  let host = site.trim().toLowerCase();
  if (!host) return null;
  try {
    host = new URL(/^[a-z][a-z\d+.-]*:/i.test(host) ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  const domain = loginSite(host);
  return Object.hasOwn(APP_SITES, domain) ? APP_SITES[domain]! : null;
}
