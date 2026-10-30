// docs/analytics.md is the promise of what the app sends: its Events table has a row for exactly the product events the
// app can send, and the docs site shows the same page.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);
const EVENT = /\b(?:track|capture)\(\s*["'`]([a-z][a-z0-9_]*)["'`]/g;

function sentEvents(): string[] {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes(".test."));
  const events = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(new URL(file, ROOT), "utf8").matchAll(EVENT)) events.add(match[1]!);
  }
  return [...events].sort();
}

/** The event names in the first column of the "## Events" table; one row may name several. */
function eventRows(docs: string): string[] {
  const start = docs.indexOf("\n## Events\n");
  const end = docs.indexOf("\n## ", start + 1);
  return docs.slice(start, end === -1 ? undefined : end).split("\n")
    .filter((line) => line.startsWith("| `"))
    .flatMap((line) => [...line.split("|")[1]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!));
}

const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");

describe("docs/analytics.md", () => {
  it("has an Events row for every event the app sends, and for no other", () => {
    const events = sentEvents();
    expect(events).toEqual(expect.arrayContaining(["app_opened", "app_snapshot", "api_key_saved", "message_sent", "onboarding_cloud"]));
    const rows = eventRows(read("docs/analytics.md"));
    expect(rows.filter((event) => !event.startsWith("$")).sort(), "Give each event its own row in docs/analytics.md").toEqual(events);
    expect(rows.filter((event) => event.startsWith("$")), "PostHog's own events the app causes").toEqual(["$identify"]);
  });

  it("is the page the docs site shows", () => {
    const docs = read("docs/analytics.md");
    const site = read("apps/docs/content/docs/security/analytics.mdx");
    expect(site.slice(site.indexOf("\n---\n", 3) + "\n---\n".length)).toBe(docs.slice(docs.indexOf("\n") + 1));
  });
});
