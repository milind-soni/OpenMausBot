import { describe, expect, it } from "vitest";

import {
  MAX_CANDIDATES,
  matchToolkits,
  searchTerms,
  type ToolCandidate,
} from "./tool-request";

/** A slice of the real catalog, blurbs included, because the blurbs are what
 * a careless matcher trips over. */
const CATALOG: ToolCandidate[] = [
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events" },
  { slug: "outlook", label: "Outlook", blurb: "Email, calendar and contacts" },
  { slug: "calendly", label: "Calendly", blurb: "Scheduling links and bookings" },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email" },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets" },
  { slug: "notion", label: "Notion", blurb: "Pages and databases" },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking" },
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels" },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code" },
  // the trap: a CRM whose description happens to mention calendars
  { slug: "hubspot", label: "HubSpot", blurb: "CRM with deals, contacts and a calendar view" },
];

const labels = (candidates: ToolCandidate[]) => candidates.map((candidate) => candidate.label);

describe("searchTerms", () => {
  it("expands a capability into the words a catalog actually uses", () => {
    expect(searchTerms("calendar")).toContain("event");
    expect(searchTerms("email")).toEqual(expect.arrayContaining(["email", "mail", "inbox"]));
  });

  it("reads plurals and phrases the way a person writes them", () => {
    expect(searchTerms("calendars")).toContain("calendar");
    expect(searchTerms("my spreadsheets")).toEqual(expect.arrayContaining(["spreadsheet", "excel"]));
  });

  it("drops words too short to mean anything", () => {
    // "a", "to" and friends match every blurb in the catalog
    expect(searchTerms("a to do")).not.toContain("a");
    expect(searchTerms("a to do")).not.toContain("to");
  });
});

describe("matchToolkits", () => {
  it("puts the app whose NAME answers the capability first", () => {
    expect(labels(matchToolkits("calendar", CATALOG))[0]).toBe("Google Calendar");
  });

  it("ranks a name match above a mention, rather than hiding the mention", () => {
    const found = labels(matchToolkits("calendar", CATALOG));
    // HubSpot's blurb ends "...and a calendar view", so it is offered — last.
    // Ranking is the right tool here, not exclusion: the person is choosing
    // from a visible list, and a mediocre fourth option costs them a glance
    // while a missing right one costs them the feature.
    expect(found.indexOf("Google Calendar")).toBeLessThan(found.indexOf("Outlook"));
    expect(found.indexOf("Outlook")).toBeLessThan(found.indexOf("HubSpot"));
  });

  it("finds an app through a synonym the catalog uses instead", () => {
    // Calendly's blurb says "scheduling", never "calendar"
    expect(labels(matchToolkits("calendar", CATALOG))).toContain("Calendly");
    expect(labels(matchToolkits("email", CATALOG))).toContain("Gmail");
    expect(labels(matchToolkits("spreadsheet", CATALOG))).toContain("Google Sheets");
  });

  it("surfaces what is already connected before offering a second one", () => {
    const found = matchToolkits("calendar", CATALOG, { connected: new Set(["outlook"]) });
    expect(found[0]!.label).toBe("Outlook");
    expect(found[0]!.connected).toBe(true);
    // and the rest are still offered, unmarked
    expect(found[1]!.connected).toBeUndefined();
  });

  it("offers nothing rather than something irrelevant", () => {
    // The next rung of the ladder is where "we have nothing for that" is
    // handled; a bad guess here sends someone to connect the wrong app.
    expect(matchToolkits("underwater welding", CATALOG)).toEqual([]);
    expect(matchToolkits("", CATALOG)).toEqual([]);
  });

  it("still answers a capability the catalog words happen to cover", () => {
    // "records" is a real catalog word — Airtable is "Bases and records" — so
    // asking for records SHOULD find it. The floor is there to drop passing
    // mentions, not to make the matcher timid.
    const records = [...CATALOG, { slug: "airtable", label: "Airtable", blurb: "Bases and records" }];
    expect(labels(matchToolkits("records", records))).toContain("Airtable");
  });

  it("never offers more than a person will read", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      slug: `cal${index}`,
      label: `Calendar ${index}`,
      blurb: "events",
    }));
    expect(matchToolkits("calendar", many)).toHaveLength(MAX_CANDIDATES);
  });

  it("orders the same catalog the same way every time", () => {
    const once = labels(matchToolkits("issues", CATALOG));
    const twice = labels(matchToolkits("issues", [...CATALOG].reverse()));
    expect(once).toEqual(twice);
  });
});

// The catalog these actually run against writes SENTENCES, not the terse
// phrases the curated fallback uses — and the first version of this matcher
// was tuned on the terse ones. Asked for analytics against the live shape it
// offered Google Analytics and Baremetrics and left out PostHog, which is the
// one the user had. These blurbs are copied from the live catalog.
describe("against live catalog blurbs", () => {
  const LIVE: ToolCandidate[] = [
    { slug: "posthog", label: "PostHog", blurb: "PostHog is an open-source product analytics platform tracking" },
    { slug: "google_analytics", label: "Google Analytics", blurb: "Google Analytics is a web analytics service" },
    { slug: "mixpanel", label: "Mixpanel", blurb: "Mixpanel is an analytics platform for product teams" },
    { slug: "baremetrics", label: "Baremetrics", blurb: "Baremetrics provides subscription analytics and metrics" },
    { slug: "salesforce", label: "Salesforce", blurb: "Salesforce is a customer relationship management platform with analytics" },
  ];

  it("offers the app whose name is not the capability but whose sentence says it is", () => {
    expect(labels(matchToolkits("analytics", LIVE))).toContain("PostHog");
    expect(labels(matchToolkits("analytics", LIVE))).toContain("Mixpanel");
  });

  it("still puts the one named for it first", () => {
    expect(labels(matchToolkits("analytics", LIVE))[0]).toBe("Google Analytics");
  });

  it("reaches synonyms through a plural, which a singular-keyed table nearly missed", () => {
    // searchTerms singularises before looking the word up, so a table keyed
    // on "analytics" was unreachable and the synonyms silently did nothing.
    expect(searchTerms("analytics")).toContain("metric");
  });
});

// The catalog is 500 entries sorted by usage, and the first version of this
// threw that ordering away. Asked for email it offered Benchmark Email,
// BlueFox Email and Bulk Email Checker — three apps whose NAME contains the
// category — and left Gmail off the end entirely. For a category word, having
// it in your name is weak evidence; being the one everybody uses is strong.
describe("uses the catalog's own usage order", () => {
  const popular: ToolCandidate[] = [
    { slug: "gmail", label: "Gmail", blurb: "Gmail is an email service by Google" },
    { slug: "outlook", label: "Outlook", blurb: "Outlook is a personal information manager with email" },
  ];
  const obscure: ToolCandidate[] = [
    { slug: "benchmark_email", label: "Benchmark Email", blurb: "Benchmark Email is a marketing tool" },
    { slug: "bulk_email_checker", label: "Bulk Email Checker", blurb: "Bulk Email Checker validates addresses" },
  ];
  // …as the catalog hands them to us: popular first.
  const catalog = [...popular, ...Array.from({ length: 200 }, (_, i) => ({
    slug: `filler${i}`, label: `Filler ${i}`, blurb: "unrelated",
  })), ...obscure];

  it("puts the app people use first, not the one named after the category", () => {
    expect(labels(matchToolkits("email", catalog)).slice(0, 2)).toEqual(["Gmail", "Outlook"]);
  });

  it("still offers the obscure ones, ranked below", () => {
    expect(labels(matchToolkits("email", catalog))).toContain("Benchmark Email");
  });

  it("never lets popularity alone qualify an app that does not match", () => {
    expect(labels(matchToolkits("email", catalog))).not.toContain("Filler 0");
  });
});
