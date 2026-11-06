// The fallback marketplace, served when no backend catalog answers. Product analytics names these
// slugs, so their order is pinned in server/composio.test.ts.
import type { CuratedConnectorSlug } from "../../shared/connector-curated.ts";
import type { ToolkitCard } from "./types.ts";

export const CURATED: Array<ToolkitCard & { slug: CuratedConnectorSlug }> = [
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", domain: "slack.com", logo: null, categories: ["Communication"] },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", domain: "github.com", logo: null, categories: ["Developer tools"] },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", domain: "gmail.com", logo: null, categories: ["Communication"] },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", domain: "calendar.google.com", logo: null, categories: ["Productivity"] },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", domain: "sheets.google.com", logo: null, categories: ["Productivity"] },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", domain: "docs.google.com", logo: null, categories: ["Productivity"] },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", domain: "drive.google.com", logo: null, categories: ["Files"] },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", domain: "notion.so", logo: null, categories: ["Productivity"] },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", domain: "linear.app", logo: null, categories: ["Developer tools"] },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", domain: "sentry.io", logo: null, categories: ["Developer tools"] },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", domain: "posthog.com", logo: null, categories: ["Analytics"] },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", domain: "discord.com", logo: null, categories: ["Communication"] },
  { slug: "twitter", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null, categories: ["Social"] },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", domain: "reddit.com", logo: null, categories: ["Social"] },
  { slug: "zapier", label: "Zapier", blurb: "Connect 9,000+ apps", domain: "zapier.com", logo: null, categories: ["Automation"] },
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates", domain: "hubspot.com", logo: null, categories: ["Sales and CRM"] },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", domain: "salesforce.com", logo: null, categories: ["Sales and CRM"] },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", domain: "atlassian.com", logo: null, categories: ["Developer tools"] },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", domain: "asana.com", logo: null, categories: ["Productivity"] },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", domain: "trello.com", logo: null, categories: ["Productivity"] },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", domain: "dropbox.com", logo: null, categories: ["Files"] },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", domain: "airtable.com", logo: null, categories: ["Productivity"] },
  { slug: "figma", label: "Figma", blurb: "Files and comments", domain: "figma.com", logo: null, categories: ["Design"] },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", domain: "stripe.com", logo: null, categories: ["Finance"] },
];

export const CURATED_SLUGS = CURATED.map((c) => c.slug);
