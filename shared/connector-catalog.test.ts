import { describe, expect, it } from "vitest";
import {
  benchlingTenantUrl,
  isBenchlingTenantUrl,
  parseCatalogResponse,
  SCIENCE_TEASER,
} from "./connector-catalog";

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  group: "papers",
  tag: "no-account",
  description: "A source",
  domain: "example.org",
  auth: "oauth",
  ...extra,
});

const section = (extra: Record<string, unknown>) => ({
  id: "science",
  title: "Science",
  locked: false,
  groups: [
    { id: "papers", title: "Papers and preprints" },
    { id: "lab", title: "Lab, data and figures" },
  ],
  entries: [],
  ...extra,
});

describe("science catalog contract", () => {
  it("the teaser lists the launch set, locked, with no address", () => {
    const [section] = SCIENCE_TEASER.sections;
    expect(section).toMatchObject({ id: "science", title: "Science", locked: true });
    expect(section!.entries.map((e) => e.id)).toEqual(["pubmed", "biorxiv", "consensus", "wiley", "chembl", "opentargets", "inductive", "clinicaltrials", "synapse", "biorender"]);
    expect(section!.entries.filter((e) => e.auth === "cloud").map((e) => e.id)).toEqual(["pubmed", "biorxiv", "chembl", "opentargets", "clinicaltrials"]);
    expect(section!.entries.some((e) => "url" in e || "urlTemplate" in e)).toBe(false);
    expect(section!.groups.map((g) => g.title)).toEqual(["Papers and preprints", "Targets and chemistry", "Clinical and regulatory", "Lab, data and figures"]);
    expect(parseCatalogResponse(SCIENCE_TEASER)).toEqual(SCIENCE_TEASER);
  });

  it("keeps a served catalog's good entries and drops the rest", () => {
    const served = {
      version: 1,
      sections: [
        section({
          entries: [
            entry("pubmed", { auth: "cloud", url: "https://cloud.example.com/science/pubmed/mcp" }),
            entry("plain-http", { url: "http://example.org/mcp" }),
            entry("evil", { domain: "evil.com/x?" }),
            entry("consensus", { url: "https://mcp.consensus.app/mcp" }),
            entry("creds", { url: "https://u:p@example.org/mcp" }),
            entry("orphan", { group: "nowhere" }),
          ],
        }),
        { ...section({}), id: "other" },
      ],
    };
    const parsed = parseCatalogResponse(served)!;
    expect(parsed.sections.map((s) => s.id)).toEqual(["science"]);
    expect(parsed.sections[0]!.entries.map((e) => e.id)).toEqual(["pubmed", "consensus"]);
    expect(parsed.sections[0]!.groups.map((g) => g.id)).toEqual(["papers"]);

    const lockedWithUrls = {
      version: 1,
      sections: [
        section({
          locked: true,
          entries: [
            entry("pubmed", { auth: "cloud", url: "https://cloud.example.com/science/pubmed/mcp" }),
            entry("benchling", { auth: "tenant", group: "lab", urlTemplate: "https://{tenant}.mcp.benchling.com/mcp" }),
          ],
        }),
      ],
    };
    const locked = parseCatalogResponse(lockedWithUrls)!;
    expect(locked.sections[0]!.entries).toHaveLength(2);
    expect(locked.sections[0]!.entries.every((e) => e.url === undefined && e.urlTemplate === undefined)).toBe(true);

    for (const bad of [null, "x", { version: 2, sections: [] }, { version: 1 }]) expect(parseCatalogResponse(bad)).toBeNull();
  });

  it("enforces url shapes by auth", () => {
    const parse = (extra: Record<string, unknown>) =>
      parseCatalogResponse({ version: 1, sections: [section({ entries: [entry("x", extra)] })] })!.sections[0]!.entries.length;
    expect(parse({ auth: "tenant", urlTemplate: "https://{tenant}.mcp.benchling.com/mcp" })).toBe(1);
    expect(parse({ auth: "tenant", url: "https://example.org/mcp" })).toBe(0);
    expect(parse({ auth: "tenant", urlTemplate: "https://{tenant}.{tenant}.example.org/mcp" })).toBe(0);
    expect(parse({ auth: "tenant", urlTemplate: "https://example.org/mcp" })).toBe(0);
    expect(parse({ docsUrl: "https://example.org/docs#frag" })).toBe(0);
    expect(parse({ name: "n".repeat(81) })).toBe(0);
    expect(parse({ description: "line\nbreak" })).toBe(0);
  });

  it("builds a Benchling address from what a person types", () => {
    for (const typed of ["acme", "acme.benchling.com", "https://acme.benchling.com/", " ACME.benchling.com/projects "]) {
      expect(benchlingTenantUrl(typed)).toBe("https://acme.mcp.benchling.com/mcp");
    }
    for (const typed of ["", "acme corp", "-acme", "acme.evil.com", "https://acme.benchling.com.evil.com", "a".repeat(64)]) {
      expect(benchlingTenantUrl(typed)).toBeNull();
    }
    expect(isBenchlingTenantUrl("https://acme.mcp.benchling.com/mcp")).toBe(true);
    for (const url of ["http://acme.mcp.benchling.com/mcp", "https://acme.mcp.benchling.com/mcp?x=1", "https://a.b.mcp.benchling.com/mcp", "https://u:p@acme.mcp.benchling.com/mcp"]) {
      expect(isBenchlingTenantUrl(url)).toBe(false);
    }
  });
});
