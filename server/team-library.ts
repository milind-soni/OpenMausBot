import { parseJson, type JsonValue } from "./schema.ts";
import { isBotPackage, parseBotPackage, parsePackageDocument, upgradeV1, type PackageDocument, type ParsedBotPackage } from "./bot-package.ts";
import { PACKAGE_V1_VERSION } from "../shared/package-format.ts";
import { parseTeamManifest, type ParsedTeamManifest } from "./team-manifest.ts";
import { grokMarketplaceSlugFrom, grokMarketplaceUrl, grokShareIdFrom, grokShareUrl, type GrokTemplateCard } from "../shared/grok-import.ts";

export const TEAM_LIBRARY_REPOSITORY = "https://github.com/milind-soni/openmausbot-teams";
export const TEAM_LIBRARY_RAW_ROOT = "https://raw.githubusercontent.com/milind-soni/openmausbot-teams/main";
export const TEAM_LIBRARY_CATALOG_URL = `${TEAM_LIBRARY_RAW_ROOT}/catalog.json`;

const MAX_CATALOG_BYTES = 256_000;
const MAX_MANIFEST_BYTES = 1_000_000;

export interface TeamCatalogEntry {
  slug: string;
  name: string;
  summary: string;
  category: string;
  outcome?: string;
  setupMinutes?: number;
  featured?: boolean;
  package?: string;
  manifest: string;
  readme: string;
  members: number;
  skills: string[];
  requires: { apps: string[] };
}

export interface TeamCatalog {
  format: "openmaus.catalog";
  version: 1;
  repositoryUrl: typeof TEAM_LIBRARY_REPOSITORY;
  teams: TeamCatalogEntry[];
}

type Fetcher = typeof fetch;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} is too long`);
  return normalized;
}

function relativeFile(value: unknown, field: string, suffix: string, prefix: string): string {
  const path = text(value, field, 300);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    !path.startsWith(prefix) ||
    !path.endsWith(suffix)
  ) {
    throw new Error(`${field} is not a safe catalog path`);
  }
  return path;
}

function stringList(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} is invalid`);
  return value.map((item, index) => text(item, `${field}[${index}]`, 100));
}

/** Validate the remotely maintained index before any of it reaches the renderer. */
export function parseTeamCatalog(value: unknown): TeamCatalog {
  if (!isRecord(value) || value.format !== "openmaus.catalog" || value.version !== 1) {
    throw new Error("The team library catalog is not supported");
  }
  if (!Array.isArray(value.teams) || value.teams.length > 100) {
    throw new Error("The team library catalog is invalid");
  }
  const slugs = new Set<string>();
  const teams = value.teams.map((raw, index): TeamCatalogEntry => {
    const field = `teams[${index}]`;
    if (!isRecord(raw)) throw new Error(`${field} is invalid`);
    const slug = text(raw.slug, `${field}.slug`, 80);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slugs.has(slug)) {
      throw new Error(`${field}.slug is invalid`);
    }
    slugs.add(slug);
    const prefix = `teams/${slug}/`;
    const requires = isRecord(raw.requires) ? raw.requires : {};
    return {
      slug,
      name: text(raw.name, `${field}.name`, 100),
      summary: text(raw.summary, `${field}.summary`, 300),
      category: text(raw.category, `${field}.category`, 80),
      ...(typeof raw.outcome === "string" ? { outcome: text(raw.outcome, `${field}.outcome`, 300) } : {}),
      ...(typeof raw.setupMinutes === "number" && Number.isSafeInteger(raw.setupMinutes) && raw.setupMinutes > 0 && raw.setupMinutes <= 240
        ? { setupMinutes: raw.setupMinutes }
        : {}),
      ...(typeof raw.featured === "boolean" ? { featured: raw.featured } : {}),
      ...(raw.package !== undefined
        ? { package: relativeFile(raw.package, `${field}.package`, ".md", "packages/") }
        : {}),
      manifest: relativeFile(raw.manifest, `${field}.manifest`, ".mausteam.json", prefix),
      readme: relativeFile(raw.readme, `${field}.readme`, "README.md", prefix),
      members:
        typeof raw.members === "number" && Number.isSafeInteger(raw.members) && raw.members > 0 && raw.members <= 200
          ? raw.members
          : (() => { throw new Error(`${field}.members is invalid`); })(),
      skills: Array.isArray(raw.skills)
        ? raw.skills.map((skill, skillIndex) =>
            relativeFile(skill, `${field}.skills[${skillIndex}]`, "SKILL.md", `${prefix}skills/`),
          )
        : (() => { throw new Error(`${field}.skills is invalid`); })(),
      requires: { apps: stringList(requires.apps ?? [], `${field}.requires.apps`, 30) },
    };
  });
  return {
    format: "openmaus.catalog",
    version: 1,
    repositoryUrl: TEAM_LIBRARY_REPOSITORY,
    teams,
  };
}

async function fetchJson(url: string, maxBytes: number, fetcher: Fetcher): Promise<JsonValue> {
  const response = await fetcher(url, {
    headers: { accept: "application/json, text/plain;q=0.9" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = Object.assign(new Error(`GitHub returned HTTP ${response.status}`), { status: response.status });
    throw error;
  }
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes) throw new Error("The remote team file is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error("The remote team file is too large");
  try {
    return parseJson(raw);
  } catch {
    throw new Error("GitHub did not return valid JSON");
  }
}

async function fetchText(url: string, maxBytes: number, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(url, {
    headers: { accept: "text/markdown, text/plain;q=0.9" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Object.assign(new Error(`GitHub returned HTTP ${response.status}`), { status: response.status });
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes) throw new Error("The remote team file is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error("The remote team file is too large");
  return raw;
}

export async function fetchTeamCatalog(fetcher: Fetcher = fetch): Promise<TeamCatalog> {
  return parseTeamCatalog(await fetchJson(TEAM_LIBRARY_CATALOG_URL, MAX_CATALOG_BYTES, fetcher));
}

export type ParsedShareableTeam = ParsedTeamManifest | ParsedBotPackage | PackageDocument;

function parseShareable(value: JsonValue | string): ParsedShareableTeam {
  if (typeof value === "string") return parseBotPackage(value);
  if (!isBotPackage(value)) return parseTeamManifest(value);
  // A shared team (v2) is read as a file: it cannot claim a publisher.
  return (value as { version?: unknown }).version === 1 ? parseBotPackage(value) : parsePackageDocument(value, { trust: "file" });
}

async function fetchShareable(url: string, fetcher: Fetcher): Promise<ParsedShareableTeam> {
  return url.endsWith(".md")
    ? parseBotPackage(await fetchText(url, MAX_MANIFEST_BYTES, fetcher))
    : parseShareable(await fetchJson(url, MAX_MANIFEST_BYTES, fetcher));
}

export async function fetchLibraryTeam(slug: string, fetcher: Fetcher = fetch): Promise<ParsedShareableTeam> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("That team name is invalid");
  const catalog = await fetchTeamCatalog(fetcher);
  const entry = catalog.teams.find((team) => team.slug === slug);
  if (!entry) throw Object.assign(new Error("That library team was not found"), { status: 404 });
  return fetchShareable(`${TEAM_LIBRARY_RAW_ROOT}/${entry.package ?? entry.manifest}`, fetcher);
}

const MAX_CHIEF_TEAMS = 30;
const MAX_ROLE_TEXT = 280;

export interface LibraryRole { name: string; title: string; does?: string; lead?: true }
export interface LibraryTeamRoles { name: string; summary: string; roles: LibraryRole[] }

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

function libraryRoles(team: ParsedShareableTeam): LibraryRole[] {
  const role = (member: { name: string; title?: string; description?: string }, lead: boolean): LibraryRole => ({
    name: member.name, title: member.title?.trim() || "Specialist",
    ...(member.description?.trim() ? { does: oneLine(member.description, MAX_ROLE_TEXT) } : {}),
    ...(lead ? { lead: true as const } : {}),
  });
  if (!("package" in team)) return team.team.members.map((member) => role(member, false));
  const pkg = team.version === PACKAGE_V1_VERSION ? upgradeV1(team).package : team.package;
  return pkg.agents.map((agent) => role(agent, agent.key === pkg.team?.leader));
}

/** Each ready-made team's name, one line and roles: enough for a Chief to create the team itself, one specialist at a
 * time. A team whose file cannot be read keeps its name and summary with no roles. */
export async function libraryTeamRoles(fetcher: Fetcher = fetch): Promise<LibraryTeamRoles[]> {
  const catalog = await fetchTeamCatalog(fetcher);
  return Promise.all(catalog.teams.slice(0, MAX_CHIEF_TEAMS).map(async (entry) => ({
    name: entry.name,
    summary: entry.summary,
    roles: await fetchShareable(`${TEAM_LIBRARY_RAW_ROOT}/${entry.package ?? entry.manifest}`, fetcher).then(libraryRoles, () => []),
  })));
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

/** Public GitHub Markdown playbooks and legacy JSON team files only; other hosts never reach server fetch. */
export function githubManifestUrls(input: string): string[] {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid GitHub URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Only public HTTPS GitHub links are supported");
  }
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (!parts.every(safeSegment)) throw new Error("That GitHub path is not supported");

  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    if (parts.length === 2) {
      const [owner, repo] = parts;
      return [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/botmrr.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/team.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/team.mausteam.json`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/botmrr.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/team.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/team.mausteam.json`,
      ];
    }
    if (parts.length >= 5 && (parts[2] === "blob" || parts[2] === "raw")) {
      const [owner, repo, , ref, ...file] = parts;
      if (!file.at(-1)?.match(/\.(?:md|json)$/)) throw new Error("The GitHub link must point to a Markdown playbook or JSON team file");
      return [`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file.join("/")}`];
    }
  }

  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
    if (!parts.at(-1)?.match(/\.(?:md|json)$/)) throw new Error("The GitHub link must point to a Markdown playbook or JSON team file");
    return [`https://raw.githubusercontent.com/${parts.join("/")}`];
  }

  throw new Error("Paste a GitHub repository, Markdown playbook, or legacy JSON team link");
}

export async function fetchGithubTeam(input: string, fetcher: Fetcher = fetch): Promise<ParsedShareableTeam> {
  const urls = githubManifestUrls(input);
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await fetchShareable(url, fetcher);
    } catch (error) {
      lastError = error;
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  throw lastError ?? new Error("No botmrr.md, team.md, or legacy team file was found in that repository");
}

const GROK_HOSTS = new Set(["x.ai", "www.x.ai"]);
const MAX_GROK_PAGE_BYTES = 2 * 1024 * 1024;
const GROK_TIMEOUT_MS = 20_000;
const MAX_GROK_REDIRECTS = 3;

const statusError = (message: string, status: number) => Object.assign(new Error(message), { status });

function onGrokHost(url: URL): boolean {
  return url.protocol === "https:" && GROK_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw statusError("That x.ai page is too large", 502);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw statusError("That x.ai page is too large", 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The Next.js flight data the page streams in `self.__next_f.push([1,"…"])` scripts, decoded and joined. */
function flightText(html: string): string {
  const marker = "self.__next_f.push([1,";
  const parts: string[] = [];
  for (let at = html.indexOf(marker); at >= 0; at = html.indexOf(marker, at + marker.length)) {
    const start = at + marker.length;
    if (html[start] !== '"') continue;
    let end = start + 1;
    while (end < html.length && html[end] !== '"') end += html[end] === "\\" ? 2 : 1;
    try {
      const chunk: unknown = JSON.parse(html.slice(start, end + 1));
      if (typeof chunk === "string") parts.push(chunk);
    } catch {
      // not a plain string chunk
    }
  }
  return parts.join("");
}

/** The JSON object that starts at `start`, or null. */
function objectAt(text: string, start: number): Record<string, unknown> | null {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length && i - start < 64_000; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i += 1;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) {
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        return isRecord(value) ? value : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The page's own record for this bot: {id, ownerType, sharerName, botName, description, color, shape}. */
function embeddedTemplate(html: string, shareId: string): Record<string, unknown> | null {
  const text = flightText(html);
  const needle = `"id":${JSON.stringify(shareId)}`;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const value = objectAt(text, text.lastIndexOf("{", at));
    if (value && value.id === shareId && typeof value.botName === "string") return value;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? match;
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function metaContent(html: string, property: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`\\b(?:property|name)=["']${property}["']`, "i").test(tag)) continue;
    const content = tag.match(/\bcontent=(?:"([^"]*)"|'([^']*)')/i);
    if (content) return decodeEntities(content[1] ?? content[2] ?? "").trim();
  }
  return "";
}

const cardText = (value: unknown, max: number) =>
  // eslint-disable-next-line no-control-regex
  typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "";

/** Name, creator and description from a share page: the embedded record first, then the og tags. */
export function grokCardFromHtml(html: string, shareId: string): GrokTemplateCard {
  const embedded = embeddedTemplate(html, shareId);
  let name = cardText(embedded?.botName, 100).replace(/\s+/g, " ");
  let creator = cardText(embedded?.sharerName, 100).replace(/\s+/g, " ");
  let description = cardText(embedded?.description, 2_000);
  if (!name) {
    const title = metaContent(html, "og:title");
    const by = title.lastIndexOf(" by ");
    name = cardText(by > 0 ? title.slice(0, by) : title, 100);
    creator = by > 0 ? cardText(title.slice(by + 4), 100) : "";
  }
  if (!description) description = cardText(metaContent(html, "og:description"), 2_000);
  if (!name) throw statusError("That x.ai page did not show a Grok Bot. The link may be private, team-only or removed.", 404);
  const color = typeof embedded?.color === "string" && /^#[0-9a-f]{3,8}$/i.test(embedded.color) ? embedded.color : undefined;
  return { shareId, name, ...(creator ? { creator } : {}), description, url: grokShareUrl(shareId), ...(color ? { color } : {}) };
}

/** An x.ai page's HTML: only https://x.ai (or www) and redirects that stay there, within the time and size caps. */
async function fetchGrokPage(target: URL, fetcher: Fetcher, signal: AbortSignal, notFound: string): Promise<string> {
  for (let hop = 0; ; hop += 1) {
    if (!onGrokHost(target)) throw statusError("That Grok Bot link tried to leave x.ai", 502);
    const response = await fetcher(target.toString(), { headers: { accept: "text/html" }, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hop >= MAX_GROK_REDIRECTS) throw statusError("x.ai did not show the Grok Bot page", 502);
      target = new URL(location, target);
      continue;
    }
    if (response.status === 404) throw statusError(notFound, 404);
    if (!response.ok) throw statusError(`x.ai returned HTTP ${response.status}`, 502);
    return readCapped(response, MAX_GROK_PAGE_BYTES);
  }
}

/** The share id a marketplace page's Add button points at: its own entry's addHref, or the page's only one. */
export function grokShareIdFromMarketplace(html: string, slug: string): string | null {
  const text = html.replace(/\\"/g, '"');
  const entry = text.indexOf(`"id":"${slug}"`);
  const next = entry >= 0 ? text.indexOf('"id":"', entry + 6) : -1;
  const own = entry >= 0 ? text.slice(entry, next > entry ? next : entry + 4_000).match(/"addHref":"\/bot\/([A-Za-z0-9_-]{21})"/) : null;
  if (own) return own[1]!;
  const all = [...new Set([...text.matchAll(/"addHref":"\/bot\/([A-Za-z0-9_-]{21})"/g)].map((match) => match[1]!))];
  return all.length === 1 ? all[0]! : null;
}

/** The public card for a Grok Bot share link or marketplace page. Fetches only x.ai pages and redirects that stay on x.ai. */
export async function fetchGrokTemplateCard(input: string, fetcher: Fetcher = fetch): Promise<GrokTemplateCard> {
  const signal = AbortSignal.timeout(GROK_TIMEOUT_MS);
  try {
    let shareId = grokShareIdFrom(input);
    const slug = shareId ? null : grokMarketplaceSlugFrom(input);
    if (!shareId && !slug) throw statusError("Paste a Grok Bot link, like https://x.ai/bot/… or a Grok Bot marketplace page", 400);
    if (slug) {
      const market = await fetchGrokPage(new URL(grokMarketplaceUrl(slug)), fetcher, signal, "That Grok Bot marketplace page was not found.");
      shareId = grokShareIdFromMarketplace(market, slug);
      if (!shareId) throw statusError("That marketplace page did not link to a Grok Bot to add.", 404);
    }
    const html = await fetchGrokPage(new URL(grokShareUrl(shareId!)), fetcher, signal, "That Grok Bot link was not found. It may be private, team-only or removed.");
    return grokCardFromHtml(html, shareId!);
  } catch (error) {
    if ((error as { name?: string }).name === "TimeoutError") throw statusError("x.ai did not answer within 20 seconds. Try again.", 502);
    throw error;
  }
}
