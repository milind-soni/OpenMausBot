import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { lf, releaseProblems, releasesSchemaText } from "./check-announcements.mjs";
import { MAX_RELEASES_FILE_BYTES, releasesText, withRelease } from "./release-notes-feed.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const NOW = Date.parse("2026-11-21T10:00:00Z");
const empty = releasesText({ $schema: "./releases.schema.json", version: 1, updatedAt: "2026-11-20T00:00:00Z", releases: [] });
const entry = (version, items = ["**Faster.** Much faster."]) => ({ version, date: "2026-11-20T00:00:00Z", sections: [{ title: "Fixes", items }] });

describe("the committed release notes", () => {
  it("are valid, with their JSON Schema up to date", () => {
    expect(releaseProblems(read("announcements/releases.json"))).toEqual([]);
    expect(lf(read("announcements/releases.schema.json")), "run node scripts/check-announcements.mjs --write-schema").toBe(releasesSchemaText());
  });
});

describe("adding a release", () => {
  it("inserts newest first, replaces the same version, and moves updatedAt forward", () => {
    let text = withRelease(empty, entry("0.1.170"), { now: NOW });
    text = withRelease(text, entry("0.1.175"), { now: NOW });
    text = withRelease(text, entry("0.1.171"), { now: NOW });
    text = withRelease(text, entry("0.1.175", ["Replaced."]), { now: NOW });
    const feed = JSON.parse(text);
    expect(feed.releases.map((release) => release.version)).toEqual(["0.1.175", "0.1.171", "0.1.170"]);
    expect(feed.releases[0].sections[0].items).toEqual(["Replaced."]);
    expect(Date.parse(feed.updatedAt)).toBeGreaterThan(Date.parse("2026-11-20T00:00:00Z"));
    expect(releaseProblems(text, { previous: empty, now: NOW })).toEqual([]);
  });

  it("keeps the latest twenty, and refuses an entry older than all of them", () => {
    let text = empty;
    for (let patch = 100; patch < 121; patch++) text = withRelease(text, entry(`0.1.${patch}`), { now: NOW });
    const versions = JSON.parse(text).releases.map((release) => release.version);
    expect(versions).toHaveLength(20);
    expect(versions[0]).toBe("0.1.120");
    expect(versions.at(-1)).toBe("0.1.101");
    expect(() => withRelease(text, entry("0.1.50"), { now: NOW })).toThrow(/older than every release/);
  });

  it("drops the oldest releases to stay under the size CI allows", () => {
    const long = Array.from({ length: 40 }, (_, index) => `Line ${index} ${"word ".repeat(100).trim()}.`);
    let text = empty;
    for (let patch = 1; patch <= 20; patch++) text = withRelease(text, entry(`0.2.${patch}`, long), { now: NOW });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RELEASES_FILE_BYTES);
    expect(JSON.parse(text).releases[0].version).toBe("0.2.20");
  });

  it("refuses one release larger than the file may be on its own", () => {
    const huge = Array.from({ length: 40 }, (_, index) => `Line ${index} ${"word ".repeat(115).trim()}.`);
    const sections = Array.from({ length: 6 }, (_, index) => ({ title: `Part ${index}`, items: huge }));
    expect(() => withRelease(empty, { version: "0.1.1", date: "2026-11-20T00:00:00Z", sections }, { now: NOW })).toThrow(/alone are larger/);
  });

  it("refuses an entry that is not valid", () => {
    expect(() => withRelease(empty, entry("0.1.1", ["<script>x</script>"]), { now: NOW })).toThrow(/valid entry/);
    expect(() => withRelease(empty, { ...entry("0.1.1"), sections: [] }, { now: NOW })).toThrow(/valid entry/);
  });
});

describe("what the check refuses", () => {
  it("a line the cleaner would change, a file that changed without moving updatedAt, and a file too large", () => {
    const withLine = (item) => releasesText({ version: 1, updatedAt: "2026-11-21T00:00:00Z", releases: [entry("0.1.1", [item])] });
    expect(releaseProblems(withLine("Plain *emphasis* here."), { now: NOW })).toEqual([expect.stringMatching(/marks the app does not draw/)]);
    expect(releaseProblems(withLine("Fine."), { now: NOW, previous: withLine("Other.") })).toEqual([expect.stringMatching(/updatedAt did not move forward/)]);
    expect(releaseProblems(`${" ".repeat(MAX_RELEASES_FILE_BYTES)}{}`, { now: NOW })).toEqual([expect.stringMatching(/larger than/)]);
  });
});
