// The organization library as the renderer sees it (server/org-library.ts):
// the shelf under Templates → From {Organization}, the preview, the
// provenance line on added bots, and the skills offered under Bot → Skills.
// Pure helpers here; the components fetch.
import { t } from "@/lib/i18n";
import type { InstalledPackageMetadata } from "../../shared/wire";
import type { PackageDocument } from "../../shared/package-format";
import { teamImportPreview, type PendingTeamImport } from "./team-import";

export interface OrgLibraryPackage {
  packageId: string;
  ref: string;
  name: string;
  tagline: string;
  kind: "team" | "library";
  publisher: { organizationId: string; name: string; self: boolean };
  mode: "required" | "available" | "off";
  release: null | { version: string; sha256: string; sizeBytes: number; formatVersion: number; publishedAt: number; notes: string };
  contents: { bots: number; skills: number; presets: number; rooms: number; routines: number; connections: number; botNames: string[] };
  scanFindings: number;
  blob: "ready" | "unavailable" | "unsupported";
  installed: { installId: string; release: string; status: "installed" | "withdrawn" | "removed" } | null;
}

export interface OrgLibraryInstall {
  installId: string;
  packageId: string;
  name: string;
  release: string;
  status: "installed" | "withdrawn" | "removed";
  publisher: string;
}

export interface OrgLibraryListing {
  organization: { id: string; name: string } | null;
  packages: OrgLibraryPackage[];
  installs?: OrgLibraryInstall[];
}

export interface OfferedOrgSkill {
  installId: string;
  packageName: string;
  publisher: string;
  release: string;
  name: string;
  description: string;
  added: boolean;
}

/** What a shelf card offers. The person's click is the decision: no dialog. */
export type OrgCardAction = "add" | "added" | "updateApp" | "notReady" | "noRelease";

export function orgCardAction(entry: OrgLibraryPackage): OrgCardAction {
  if (entry.installed && entry.installed.status !== "removed") return "added";
  if (!entry.release) return "noRelease";
  if (entry.blob === "unsupported") return "updateApp";
  if (entry.blob !== "ready") return "notReady";
  return "add";
}

/** "From Acme Partners", or "Your organization" for its own packages. */
export function orgPublisherLine(entry: Pick<OrgLibraryPackage, "publisher">): string {
  return entry.publisher.self ? t("orgLibrary.fromSelf") : t("orgLibrary.from", { name: entry.publisher.name });
}

/** Required is treated as Available in this version, with a badge. */
export function orgModeBadge(entry: Pick<OrgLibraryPackage, "mode" | "publisher">): string | null {
  return entry.mode === "required" ? t("orgLibrary.recommended", { name: entry.publisher.name }) : null;
}

/** The small print under a card: withdrawn, or a newer release waiting. */
export function orgCardNotes(entry: OrgLibraryPackage): string[] {
  const notes: string[] = [];
  if (entry.installed?.status === "withdrawn") notes.push(t("orgLibrary.withdrawn", { name: entry.publisher.name }));
  if (entry.installed && entry.installed.status !== "removed" && entry.release && entry.release.version !== entry.installed.release) {
    notes.push(t("orgLibrary.newerRelease", { version: entry.release.version }));
  }
  return notes;
}

/** "3 bots · 3 skills · 1 group chat · 2 routines" — only what it has. */
export function orgContentsLine(contents: OrgLibraryPackage["contents"]): string {
  const parts: string[] = [];
  if (contents.bots) parts.push(t("orgLibrary.bots", { count: contents.bots }));
  if (contents.skills) parts.push(t("orgLibrary.skills", { count: contents.skills }));
  if (contents.presets) parts.push(t("orgLibrary.presets", { count: contents.presets }));
  if (contents.rooms) parts.push(t("orgLibrary.rooms", { count: contents.rooms }));
  if (contents.routines) parts.push(t("orgLibrary.routines", { count: contents.routines }));
  if (contents.connections) parts.push(t("orgLibrary.connections", { count: contents.connections }));
  return parts.join(" · ");
}

/** The line under a bot that came from the organization's library: "From
 * Sales desk 1.3.0 · Acme Partners", "Withdrawn by Acme Partners" once its
 * publisher pulls it. A bot imported from a file shows nothing new, as before
 * (contract §5.7: the line is for organization packages). */
export function packageProvenance(
  stamp: InstalledPackageMetadata | undefined,
  installs: readonly OrgLibraryInstall[] = [],
): { line: string; withdrawn: string | null } | null {
  if (stamp?.source !== "org") return null;
  const publisher = stamp.publisher?.name ?? "";
  const install = installs.find((candidate) => candidate.installId === stamp.installId);
  return {
    line: publisher
      ? t("orgLibrary.provenance", { name: stamp.name, release: stamp.release, publisher })
      : t("orgLibrary.provenanceFile", { name: stamp.name, release: stamp.release }),
    withdrawn: install?.status === "withdrawn" ? t("orgLibrary.withdrawn", { name: install.publisher || publisher }) : null,
  };
}

/** The existing import preview, for a package from the organization. A
 * team reads exactly as a shared file does; a skills-only package has no
 * team, only what it offers. */
export function orgPackagePreview(document: PackageDocument): PendingTeamImport {
  if (document.package.agents.length) return teamImportPreview(document);
  const pkg = document.package;
  return {
    manifest: document,
    kind: "package",
    version: 2,
    name: pkg.name,
    teamName: pkg.name,
    description: pkg.summary,
    members: [],
    rooms: 0,
    playbooks: pkg.playbooks?.length ?? 0,
    routines: 0,
    apps: pkg.requirements.apps.map((app) => ({ label: app.label, optional: app.optional === true })),
    skills: [],
    offeredSkills: (pkg.skills?.entries ?? []).map((skill) => skill.name),
    connections: [],
    notes: 0,
    presets: (pkg.presets ?? []).map((preset) => preset.name),
  };
}
