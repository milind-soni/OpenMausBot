import { z } from "zod";

/** What an entry costs the person, shown as its tag. */
export type ScienceTag = "no-account" | "free-account" | "paid-account" | "subscription";

/**
 * How an entry connects: "cloud" goes through the Cloud's science relay,
 * "oauth" is a vendor server with its own sign-in, "tenant" is a vendor server
 * whose address contains the person's tenant name.
 */
export type CatalogAuth = "cloud" | "oauth" | "tenant";

export interface CatalogEntry {
  /** Stable id, e.g. "pubmed". */
  id: string;
  name: string;
  /** A `CatalogGroup.id` of the same section. */
  group: string;
  tag: ScienceTag;
  /** One line. */
  description: string;
  /** Favicon domain, e.g. "pubmed.ncbi.nlm.nih.gov". */
  domain: string;
  auth: CatalogAuth;
  docsUrl?: string;
  /** Present only while the section is unlocked; never for "tenant". */
  url?: string;
  /** "tenant" entries only, unlocked only: "https://{tenant}.mcp.benchling.com/mcp". */
  urlTemplate?: string;
}

export interface CatalogGroup {
  id: string;
  title: string;
}

export interface CatalogSection {
  id: "science";
  title: "Science";
  /** True unless the account or machine tier has the science allowance. */
  locked: boolean;
  groups: CatalogGroup[];
  entries: CatalogEntry[];
}

export interface CatalogResponse {
  version: 1;
  sections: CatalogSection[];
}

export const CATALOG_ENTRY_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const SCIENCE_GROUP_IDS = ["papers", "targets", "clinical", "lab"] as const;
export const ALL_VIEW_SCIENCE_IDS = ["pubmed", "chembl", "clinicaltrials", "biorender"] as const;

const hasControlChar = (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const FAVICON_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const plainText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !hasControlChar(s));

function isPlainHttps(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}

const httpsUrl = z.string().refine(isPlainHttps);
const tenantTemplate = z
  .string()
  .refine((s) => s.split("{tenant}").length === 2 && isPlainHttps(s.replace("{tenant}", "tenant")));

const entrySchema = z
  .object({
    id: z.string().regex(CATALOG_ENTRY_ID),
    name: plainText(80),
    group: z.string(),
    tag: z.enum(["no-account", "free-account", "paid-account", "subscription"]),
    description: plainText(160),
    domain: z.string().regex(FAVICON_DOMAIN),
    auth: z.enum(["cloud", "oauth", "tenant"]),
    docsUrl: httpsUrl.optional(),
    url: httpsUrl.optional(),
    urlTemplate: tenantTemplate.optional(),
  })
  .refine((e) => e.auth !== "tenant" || e.url === undefined);

const groupSchema = z.object({ id: z.string().min(1).max(40), title: plainText(80) });

function parseSection(value: unknown): CatalogSection | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.id !== "science" || typeof raw.locked !== "boolean") return null;
  if (!Array.isArray(raw.groups) || !Array.isArray(raw.entries)) return null;
  const locked = raw.locked;
  const groups = raw.groups.flatMap((g) => {
    const parsed = groupSchema.safeParse(g);
    return parsed.success ? [parsed.data] : [];
  });
  const groupIds = new Set(groups.map((g) => g.id));
  const entries: CatalogEntry[] = [];
  for (const candidate of raw.entries) {
    const parsed = entrySchema.safeParse(candidate);
    if (!parsed.success || !groupIds.has(parsed.data.group)) continue;
    const { url, urlTemplate, ...rest } = parsed.data;
    entries.push(locked ? rest : { ...rest, ...(url ? { url } : {}), ...(urlTemplate ? { urlTemplate } : {}) });
  }
  const used = new Set(entries.map((e) => e.group));
  return { id: "science", title: "Science", locked, groups: groups.filter((g) => used.has(g.id)), entries };
}

/** Keeps every well-formed entry of a served catalog and drops the rest; null when the payload is not a v1 catalog. */
export function parseCatalogResponse(value: unknown): CatalogResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.sections)) return null;
  const sections = raw.sections.flatMap((s) => {
    const parsed = parseSection(s);
    return parsed ? [parsed] : [];
  });
  return { version: 1, sections };
}

type Row = readonly [id: string, name: string, group: (typeof SCIENCE_GROUP_IDS)[number], tag: ScienceTag, description: string, domain: string, auth: CatalogAuth];

const TEASER_ROWS: readonly Row[] = [
  ["pubmed", "PubMed", "papers", "no-account", "Biomedical papers and abstracts from NCBI", "pubmed.ncbi.nlm.nih.gov", "cloud"],
  ["biorxiv", "bioRxiv and medRxiv", "papers", "no-account", "Preprints in biology and medicine", "biorxiv.org", "cloud"],
  ["consensus", "Consensus", "papers", "free-account", "Answers drawn from peer-reviewed studies", "consensus.app", "oauth"],
  ["wiley", "Wiley Scholar Gateway", "papers", "free-account", "Full text from Wiley journals", "wiley.com", "oauth"],
  ["chembl", "ChEMBL", "targets", "no-account", "Bioactive molecules, targets and assays", "chembl.gitbook.io", "cloud"],
  ["opentargets", "Open Targets", "targets", "no-account", "Evidence linking targets to diseases", "platform.opentargets.org", "cloud"],
  ["inductive", "Inductive Bio", "targets", "free-account", "ADMET predictions for your molecules", "inductive.bio", "oauth"],
  ["clinicaltrials", "Clinical Trials", "clinical", "no-account", "Studies from ClinicalTrials.gov", "clinicaltrials.gov", "cloud"],
  ["synapse", "Synapse", "lab", "free-account", "Shared research datasets from Sage", "synapse.org", "oauth"],
  ["biorender", "BioRender", "lab", "free-account", "Scientific figures and icons", "biorender.com", "oauth"],
];

const GROUP_TITLES: Record<(typeof SCIENCE_GROUP_IDS)[number], string> = {
  papers: "Papers and preprints",
  targets: "Targets and chemistry",
  clinical: "Clinical and regulatory",
  lab: "Lab, data and figures",
};

/** The launch set, locked and without addresses, shown before any catalog has been served. */
export const SCIENCE_TEASER: CatalogResponse = {
  version: 1,
  sections: [
    {
      id: "science",
      title: "Science",
      locked: true,
      groups: SCIENCE_GROUP_IDS.map((id) => ({ id, title: GROUP_TITLES[id] })),
      entries: TEASER_ROWS.map(([id, name, group, tag, description, domain, auth]) => ({ id, name, group, tag, description, domain, auth })),
    },
  ],
};

const TENANT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BENCHLING_MCP_URL = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.mcp\.benchling\.com\/mcp$/;

/** The MCP address for what a person typed: a tenant name or its benchling.com address. */
export function benchlingTenantUrl(address: string): string | null {
  const host = address
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/)[0]!;
  const label = host.endsWith(".benchling.com") ? host.slice(0, -".benchling.com".length) : host;
  return TENANT_LABEL.test(label) ? `https://${label}.mcp.benchling.com/mcp` : null;
}

export function isBenchlingTenantUrl(url: string): boolean {
  return BENCHLING_MCP_URL.test(url);
}
