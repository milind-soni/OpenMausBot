import { describe, expect, it } from "vitest";
import { SCIENCE_TEASER, type CatalogEntry, type CatalogSection } from "../../shared/connector-catalog";
import {
  allViewEntries,
  catalogServerName,
  connectedEntries,
  entryServer,
  groupTitle,
  groupedEntries,
  matchesSearch,
  publicEntries,
  scienceSection,
  scienceServers,
  serverConnected,
  tagLabel,
  type ScienceServer,
} from "./science-catalog";

const section = SCIENCE_TEASER.sections[0]!;
const PUBMED_URL = "https://cloud.openmausbot.com/api/cloud/services/science/pubmed/mcp/";
const unlocked: CatalogSection = {
  ...section,
  locked: false,
  entries: section.entries.map((e) => (e.id === "pubmed" ? { ...e, url: PUBMED_URL } : e)),
};
const entry = (id: string): CatalogEntry => unlocked.entries.find((e) => e.id === id)!;
const server = (over: Partial<ScienceServer> & { name: string; url: string }): ScienceServer => ({ enabled: true, ...over });
const benchling: CatalogEntry = { id: "benchling", name: "Benchling", group: "lab", tag: "subscription", description: "Notebooks", domain: "benchling.com", auth: "tenant", urlTemplate: "https://{tenant}.mcp.benchling.com/mcp" };

describe("science catalog view logic", () => {
  it("reads remote servers and the section", () => {
    const listing = [
      { name: "a", command: "x", args: [], envKeys: [], enabled: true },
      { name: "b", type: "http", url: "https://x.example/mcp", headerKeys: [], enabled: false, auth: "needs-max", catalog: { id: "pubmed", auth: "cloud" } },
      null,
    ];
    expect(scienceServers(listing)).toEqual([{ name: "b", url: "https://x.example/mcp", enabled: false, auth: "needs-max", catalog: { id: "pubmed", auth: "cloud" } }]);
    expect(scienceSection({ version: 1, sections: [section] })).toBe(section);
    expect(scienceSection({ version: 1, sections: [] })).toBeNull();
  });

  it("matches a hand-added server by address", () => {
    const hand = server({ name: "my-pubmed", url: "HTTPS://Cloud.OpenMausBot.com/api/cloud/services/science/pubmed/mcp" });
    expect(entryServer(entry("pubmed"), [hand])).toBe(hand);
    const other = server({ name: "dup", url: PUBMED_URL, catalog: { id: "chembl", auth: "cloud" } });
    expect(entryServer(entry("chembl"), [other])).toBe(other);
    expect(entryServer(entry("pubmed"), [other])).toBeNull();
    const marked = server({ name: "pm", url: "https://elsewhere.example/mcp", catalog: { id: "pubmed", auth: "cloud" } });
    expect(entryServer(entry("pubmed"), [hand, marked])).toBe(marked);
    const tenant = server({ name: "acme", url: "https://acme.mcp.benchling.com/mcp" });
    expect(entryServer(benchling, [hand, tenant])).toBe(tenant);
  });

  it("tolerates an unlocked entry with no address", () => {
    const noUrl: CatalogEntry = { ...entry("pubmed") };
    delete noUrl.url;
    expect(entryServer(noUrl, [server({ name: "x", url: PUBMED_URL })])).toBeNull();
  });

  it("connected means enabled and usable", () => {
    expect(serverConnected(null)).toBe(false);
    expect(serverConnected(server({ name: "a", url: "u", auth: "needs-sign-in" }))).toBe(false);
    expect(serverConnected(server({ name: "a", url: "u", auth: "needs-max" }))).toBe(false);
    expect(serverConnected(server({ name: "a", url: "u", enabled: false }))).toBe(false);
    expect(serverConnected(server({ name: "a", url: "u" }))).toBe(true);
    expect(serverConnected(server({ name: "a", url: "u", auth: "signed-in" }))).toBe(true);
  });

  it("names entries from their id", () => {
    expect(catalogServerName("pubmed", [])).toBe("pubmed");
    expect(catalogServerName("pubmed", ["pubmed"])).toBe("pubmed-2");
    expect(catalogServerName("pubmed", ["pubmed", "pubmed-2"])).toBe("pubmed-3");
    const long = "a".repeat(40);
    expect(catalogServerName(long, [])).toHaveLength(32);
    expect(catalogServerName(long, ["a".repeat(32)])).toBe(`${"a".repeat(30)}-2`);
  });

  it("searches name and description", () => {
    const ids = (q: string) => section.entries.filter((e) => matchesSearch(e, q)).map((e) => e.id);
    expect(ids("chem")).toEqual(["chembl"]);
    expect(ids("  PREPRINTS ")).toEqual(["biorxiv"]);
    expect(ids("")).toHaveLength(section.entries.length);
  });

  it("groups keep catalog order and drop empty groups", () => {
    expect(groupedEntries(section, "").map((g) => g.group.id)).toEqual(["papers", "targets", "clinical", "lab"]);
    expect(groupedEntries(section, "chem").map((g) => [g.group.id, g.entries.map((e) => e.id)])).toEqual([["targets", ["chembl"]]]);
    expect(groupedEntries(section, "zzzz")).toEqual([]);
  });

  it("the All view shows the four headline sources, or every match while searching", () => {
    expect(allViewEntries(section, "").map((e) => e.id)).toEqual(["pubmed", "chembl", "clinicaltrials", "biorender"]);
    expect(allViewEntries(section, "chem").map((e) => e.id)).toEqual(["chembl"]);
  });

  it("lists public and connected entries", () => {
    expect(publicEntries(section).every((e) => e.tag === "no-account")).toBe(true);
    expect(publicEntries(section).map((e) => e.id)).toContain("pubmed");
    expect(connectedEntries(unlocked, [server({ name: "my-pubmed", url: PUBMED_URL })]).map((e) => e.id)).toEqual(["pubmed"]);
  });

  it("known groups and tags read in the app's language", () => {
    expect(tagLabel("free-account")).toBe("Free account");
    expect(tagLabel("no-account")).toBe("No account");
    expect(tagLabel("paid-account")).toBe("Paid account");
    expect(tagLabel("subscription")).toBe("Subscription");
    expect(groupTitle({ id: "papers", title: "x" })).toBe("Papers and preprints");
    expect(groupTitle({ id: "newgroup", title: "Served title" })).toBe("Served title");
  });
});
