import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  orgCardAction,
  orgCardNotes,
  orgContentsLine,
  orgModeBadge,
  orgPackagePreview,
  orgPublisherLine,
  packageProvenance,
  type OrgLibraryPackage,
} from "./org-library";
import { OrgLibraryTab } from "@/components/TeamLibraryPanelOrg";
import { TeamImportDetails } from "@/components/TeamLibraryPanel";
import { parsePackageDocument } from "../../shared/package-format";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "shared", "package-fixtures", name), "utf8"));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

function entry(patch: Partial<OrgLibraryPackage> = {}): OrgLibraryPackage {
  return {
    packageId: "22222222-2222-4222-8222-222222222222",
    ref: "acme/sales-desk",
    name: "Sales desk",
    tagline: "Qualify leads, research prospects and write outreach.",
    kind: "team",
    publisher: { organizationId: "33333333-3333-4333-8333-333333333333", name: "Acme Partners", self: false },
    mode: "available",
    release: { version: "1.3.0", sha256: "a".repeat(64), sizeBytes: 10, formatVersion: 2, publishedAt: 1, notes: "" },
    contents: { bots: 3, skills: 3, presets: 1, rooms: 1, routines: 2, connections: 1, botNames: ["Morgan", "Scout", "Quill"] },
    scanFindings: 0,
    blob: "ready",
    installed: null,
    ...patch,
  };
}

describe("the shelf card", () => {
  it("offers Add only for a verified file it can read", () => {
    expect(orgCardAction(entry())).toBe("add");
    expect(orgCardAction(entry({ blob: "unavailable" }))).toBe("notReady");
    expect(orgCardAction(entry({ blob: "unsupported" }))).toBe("updateApp");
    expect(orgCardAction(entry({ release: null, blob: "unavailable" }))).toBe("noRelease");
    expect(orgCardAction(entry({ installed: { installId: "b".repeat(32), release: "1.3.0", status: "installed" } }))).toBe("added");
    expect(orgCardAction(entry({ installed: { installId: "b".repeat(32), release: "1.3.0", status: "withdrawn" } }))).toBe("added");
    // Removed locally: the person may add it again.
    expect(orgCardAction(entry({ installed: { installId: "b".repeat(32), release: "1.3.0", status: "removed" } }))).toBe("add");
  });

  it("names the publisher, the Recommended badge, a waiting release and a withdrawal", () => {
    expect(orgPublisherLine(entry())).toBe("From Acme Partners");
    expect(orgPublisherLine(entry({ publisher: { organizationId: "x", name: "Customer Co", self: true } }))).toBe("Your organization");
    expect(orgModeBadge(entry())).toBeNull();
    expect(orgModeBadge(entry({ mode: "required" }))).toBe("Recommended by Acme Partners");
    expect(orgCardNotes(entry({ installed: { installId: "b".repeat(32), release: "1.2.0", status: "installed" } }))).toEqual([
      "Version 1.3.0 available. Updates arrive automatically in an upcoming OpenMausBot update.",
    ]);
    expect(orgCardNotes(entry({ release: null, installed: { installId: "b".repeat(32), release: "1.3.0", status: "withdrawn" } }))).toEqual([
      "Withdrawn by Acme Partners",
    ]);
    expect(orgContentsLine(entry().contents)).toBe("Bots: 3 · Skills: 3 · Preset bots: 1 · Group chats: 1 · Routines: 2 · Connections: 1");
    expect(orgContentsLine({ bots: 0, skills: 2, presets: 0, rooms: 0, routines: 0, connections: 0, botNames: [] })).toBe("Skills: 2");
  });

  it("renders cards with Add, Added and update text, and no confirm step", () => {
    const onAdd = vi.fn();
    const markup = renderToStaticMarkup(createElement(OrgLibraryTab, {
      listing: {
        organization: { id: "o", name: "Customer Co" },
        packages: [
          entry({ mode: "required" }),
          entry({ packageId: "p2", name: "Support desk", installed: { installId: "c".repeat(32), release: "1.3.0", status: "installed" } }),
          entry({ packageId: "p3", name: "Future desk", blob: "unsupported" }),
        ],
      },
      busy: null, notice: "", error: "", onAdd, onDetails: vi.fn(),
    }));
    const shown = text(markup);
    for (const line of ["Packages Customer Co shares with you", "Sales desk", "Recommended by Acme Partners", "From Acme Partners", "Added", "Update OpenMausBot to add this"]) {
      expect(shown).toContain(line);
    }
    expect(markup).toContain('aria-label="Add Sales desk"');
    expect(markup).not.toContain('aria-label="Add Support desk"');
    expect(markup).not.toContain('aria-label="Add Future desk"');
    expect(onAdd).not.toHaveBeenCalled();
    expect(text(renderToStaticMarkup(createElement(OrgLibraryTab, {
      listing: { organization: { id: "o", name: "Customer Co" }, packages: [] }, busy: null, notice: "", error: "", onAdd, onDetails: vi.fn(),
    })))).toContain("Customer Co hasn't shared any packages with you yet.");
  });
});

describe("the preview and the provenance line", () => {
  it("previews an organization team with its skills switched on, and a skills-only package without a team", () => {
    const team = parsePackageDocument({ ...fixture("full-team.v2.json") });
    const preview = orgPackagePreview(team);
    expect(preview).toMatchObject({ kind: "package", version: 2, name: "Sales desk", members: expect.arrayContaining([{ name: "Scout", title: "Prospect researcher" }]) });
    const shown = text(renderToStaticMarkup(createElement(TeamImportDetails, { pending: preview, importedNames: preview.members.map((member) => member.name), org: true })));
    expect(shown).toContain("Included skills — switched on");
    expect(shown).toContain("Skills arrive switched on and routines paused");
    expect(shown).not.toContain("added switched off");

    const library = orgPackagePreview(parsePackageDocument(fixture("library-only.v2.json")));
    expect(library).toMatchObject({ name: "Sales skills", members: [], offeredSkills: ["objection-handling", "follow-up"], presets: ["Support agent"] });
    const libraryShown = text(renderToStaticMarkup(createElement(TeamImportDetails, { pending: library, importedNames: [], org: true })));
    expect(libraryShown).toContain("Nothing is added to your bots yet");
    expect(libraryShown).not.toContain("Team members");
  });

  it("says where a bot came from, and when its release was withdrawn", () => {
    expect(packageProvenance(undefined)).toBeNull();
    // A bot imported from a file (old records have no source) shows nothing
    // new: with no organization, Bot settings stays as it was.
    expect(packageProvenance({ id: "sales-desk", name: "Sales desk", release: "1.3.0", requiredApps: [] })).toBeNull();
    expect(packageProvenance({ id: "sales-desk", name: "Sales desk", release: "1.3.0", requiredApps: [], source: "file", installId: "f".repeat(32) })).toBeNull();
    const stamp = { id: "sales-desk", name: "Sales desk", release: "1.3.0", requiredApps: [], source: "org" as const, installId: "d".repeat(32),
      publisher: { organizationId: "p", slug: "acme", name: "Acme Partners" } };
    expect(packageProvenance(stamp)).toEqual({ line: "From Sales desk 1.3.0 · Acme Partners", withdrawn: null });
    expect(packageProvenance(stamp, [{ installId: "d".repeat(32), packageId: "x", name: "Sales desk", release: "1.3.0", status: "withdrawn", publisher: "Acme Partners" }]))
      .toEqual({ line: "From Sales desk 1.3.0 · Acme Partners", withdrawn: "Withdrawn by Acme Partners" });
  });
});
