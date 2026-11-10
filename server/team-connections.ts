// Company-wide or per-person connections on a Team Cloud. Every app (a Composio toolkit) and MCP server has a scope:
// `team`, the default, is one connection an admin makes and every turn uses; `person` is one connection per member, used
// only in that member's own turns in their private chat.
//   - team-connection-scopes.json: which apps and servers are `person` (no secret; backups carry it);
//   - people-connections/: each member's own installation on the connected-apps service (their own Composio user), their
//     own MCP keys and their own MCP sign-ins. While the team has its own Composio project key, a member's apps are
//     their own Composio user in that project instead (project-apps.json: a user id and a Session id, no secret), and
//     nothing of theirs is sent to the connected-apps service.
// Security: 0600 files in a 0700 folder that no backup carries and no bot box binds; a member's key and sign-in are pinned
// to the server's address, so an admin re-pointing a server never sends them on.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { ensureManagedComposioCredentials, managedComposioAccess } from "../electron/managed-composio.mjs";
import { writeFileAtomic } from "./atomic.ts";
import { removeUserConnections } from "./composio-project.ts";
import { keepSessionWith } from "./composio-session.ts";
import { McpOAuthManager, type McpRefreshOutcome, type McpSignInPhase } from "./mcp-oauth.ts";
import type { McpOAuthClientConfig } from "./mcp-registry.ts";

export type ConnectionScope = "team" | "person";
export type ConnectionKind = "app" | "mcp";

export const SCOPES_FILE = "team-connection-scopes.json";
export const PEOPLE_CONNECTIONS_DIR = "people-connections";
/** Composio's toolkit slugs; an MCP server's name as mcp-registry.ts allows it. */
export const APP_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MCP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const PERSON = /^p_[\w-]{22}$/;
const TOKEN = /^[0-9a-f]{64}$/;

const scopesSchema = z.object({
  v: z.literal(1),
  apps: z.record(z.string(), z.literal("person")).default({}),
  mcp: z.record(z.string(), z.literal("person")).default({}),
});
type ScopesFile = z.infer<typeof scopesSchema>;

/** Which apps and MCP servers each person connects for themselves; everything else is the team's. */
export class ConnectionScopes {
  private data: ScopesFile;
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    let parsed: ScopesFile | null = null;
    try { parsed = scopesSchema.parse(JSON.parse(readFileSync(file, "utf8"))); } catch { parsed = null; }
    this.data = parsed ?? { v: 1, apps: {}, mcp: {} };
  }
  /** The `person` apps (slugs) and servers (names), sorted. */
  person(kind: ConnectionKind): string[] {
    return Object.keys(kind === "app" ? this.data.apps : this.data.mcp).sort();
  }
  scope(kind: ConnectionKind, id: string): ConnectionScope {
    return Object.hasOwn(kind === "app" ? this.data.apps : this.data.mcp, id) ? "person" : "team";
  }
  set(kind: ConnectionKind, id: string, scope: ConnectionScope): void {
    const next: ScopesFile = { v: 1, apps: { ...this.data.apps }, mcp: { ...this.data.mcp } };
    const map = kind === "app" ? next.apps : next.mcp;
    if (scope === "person") map[id] = "person"; else delete map[id];
    writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    this.data = next;
  }
}

/** The `person` app a Composio tool belongs to (GMAIL_SEND_EMAIL → gmail), the longest matching slug; null if none. */
export function personAppOf(tool: string, personApps: readonly string[]): string | null {
  let match: string | null = null;
  for (const slug of personApps) {
    if (tool.toUpperCase().startsWith(`${slug.toUpperCase()}_`) && (match === null || slug.length > match.length)) match = slug;
  }
  return match;
}

/** An app's name from its slug, as people read it: "google_search_console" → "Google Search Console". */
export const appLabel = (slug: string): string =>
  slug.split(/[-_]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || slug;

const appsSchema = z.object({
  v: z.literal(1),
  brokerUrl: z.string(),
  people: z.record(z.string(), z.object({ email: z.string(), installationId: z.string().min(1), token: z.string().regex(TOKEN) })).default({}),
});
const keysSchema = z.object({
  v: z.literal(1),
  people: z.record(z.string(), z.object({
    email: z.string(),
    servers: z.record(z.string(), z.object({ url: z.string(), header: z.string(), value: z.string() })).default({}),
  })).default({}),
});
const projectAppsSchema = z.object({
  v: z.literal(1),
  /** Which project key the Sessions and waiting removals below were made with: a short hash, never the key. */
  keyMark: z.string(),
  people: z.record(z.string(), z.object({ email: z.string(), userId: z.string().min(1), sessionId: z.string().optional(), again: z.literal(true).optional() })).default({}),
  /** Composio users of people who left, whose connections in the project are still to be removed. */
  removals: z.array(z.string()).default([]),
});
type ProjectAppsFile = z.infer<typeof projectAppsSchema>;
type AppsFile = z.infer<typeof appsSchema>;
type KeysFile = z.infer<typeof keysSchema>;
export interface PersonKey { url: string; header: string; value: string }
export interface BrokerAccess { url: string; token: string }
/** A member's own Composio user in the team's project: what `cfg.composio` is for a call made as them. */
export interface ProjectAccess { composio: { apiKey: string; userId: string; sessionId?: string } }
/** A member's own apps: their installation on the connected-apps service, or with the team's own key their Composio user. */
export type PersonAppsAccess = BrokerAccess | ProjectAccess;
export const isProjectAccess = (access: PersonAppsAccess | null | undefined): access is ProjectAccess => Boolean(access && "composio" in access);

const keyMarkOf = (apiKey: string) => createHash("sha256").update("omb-project-apps\0").update(apiKey).digest("hex").slice(0, 16);

/** A member's Composio user id in the team's project: the same at every start, from the team's id and the person key (a
 * hash), so Composio is given no address.
 * Security: never `openmausbot_…`, the prefix a personal installation on the same key may adopt as its own user. */
export function memberComposioUser(teamId: string, person: string): string {
  return `omb_member_${createHash("sha256").update("omb-team-member\0").update(teamId).update("\0").update(person).digest("hex").slice(0, 32)}`;
}

export interface PeopleConnectionsOptions {
  dataDir: string;
  /** The connected-apps service a member's own installation is made on (the Cloud home's own); null: none here. */
  brokerUrl: () => string | null;
  /** The team's id and its own Composio project key, when it has one: members' apps then live in that project. */
  teamId?: string;
  projectKey?: () => string | null;
  /** The team server's sign-in app for an MCP server, when an admin set one (config.json `oauth`). */
  clients: (name: string, url: string) => McpOAuthClientConfig | undefined;
  isOwnerLive: (owner: string) => boolean;
  /** Each member's sign-in ending, as McpOAuthManager's own option hears it. */
  onSettled?: (name: string, phase: McpSignInPhase, owner: string) => void;
  /** How each refresh of a member's own sign-in ended. */
  onRefresh?: (person: string, name: string, outcome: McpRefreshOutcome) => void;
  /** A member signed in again, saved a key or started connecting an app: what was known about their old one is stale. */
  onChanged?: (person: string, kind: ConnectionKind, id: string) => void;
  fetchImpl?: typeof fetch;
}

/** Each member's own connections: never read by a route that answers with them, never copied into a turn but theirs. */
export class PeopleConnections {
  readonly dir: string;
  private readonly managers = new Map<string, McpOAuthManager>();
  private readonly registering = new Map<string, Promise<BrokerAccess | null>>();
  private readonly projectUsers = new Map<string, ProjectAccess["composio"]>();
  private readonly options: PeopleConnectionsOptions;
  constructor(options: PeopleConnectionsOptions) {
    this.options = options;
    this.dir = join(options.dataDir, PEOPLE_CONNECTIONS_DIR);
  }

  private ensureDir(): void {
    mkdirSync(join(this.dir, "mcp-oauth"), { recursive: true, mode: 0o700 });
    try { chmodSync(this.dir, 0o700); } catch {}
  }
  private read<T>(name: string, schema: z.ZodType<T>, empty: T): T {
    try { return schema.parse(JSON.parse(readFileSync(join(this.dir, name), "utf8"))); } catch { return empty; }
  }
  private write(name: string, value: unknown): void {
    this.ensureDir();
    writeFileAtomic(join(this.dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }
  private apps(): AppsFile {
    const url = this.options.brokerUrl();
    const file = this.read<AppsFile>("apps.json", appsSchema, { v: 1, brokerUrl: url ?? "", people: {} });
    // A token goes only to the service that issued it.
    return url && file.brokerUrl === url ? file : { v: 1, brokerUrl: url ?? "", people: {} };
  }
  private keys(): KeysFile {
    return this.read<KeysFile>("mcp-keys.json", keysSchema, { v: 1, people: {} });
  }

  private projectKey(): string | null {
    return this.options.teamId ? this.options.projectKey?.() ?? null : null;
  }
  private stored<T>(name: string, schema: z.ZodType<T>): T | null {
    try { return schema.parse(JSON.parse(readFileSync(join(this.dir, name), "utf8"))); } catch { return null; }
  }
  /** What is kept for the project this key opens. Under another key the Sessions are gone, everyone connects again, and
   * a removal still waiting can't be done any more: the earlier project's connections are out of reach. */
  private projectApps(apiKey: string): ProjectAppsFile {
    const keyMark = keyMarkOf(apiKey);
    const file = this.stored("project-apps.json", projectAppsSchema);
    if (!file) return { v: 1, keyMark, people: {}, removals: [] };
    if (file.keyMark === keyMark) return file;
    if (file.removals.length) console.warn(`[team connections] the Composio project key changed: ${file.removals.length} member(s) who left still have connections in the earlier project, which can't be removed from here`);
    this.projectUsers.clear();
    const moved: ProjectAppsFile = { v: 1, keyMark, removals: [], people: Object.fromEntries(Object.entries(file.people).map(([person, record]) => [person, { email: record.email, userId: record.userId, again: true as const }])) };
    this.write("project-apps.json", moved);
    return moved;
  }
  private projectAccess(person: string, apiKey: string): ProjectAccess | null {
    const record = this.projectApps(apiKey).people[person];
    if (!record) return null;
    let composio = this.projectUsers.get(person);
    if (!composio || composio.userId !== record.userId) {
      composio = { apiKey, userId: record.userId, ...(record.sessionId ? { sessionId: record.sessionId } : {}) };
      this.projectUsers.set(person, composio);
      keepSessionWith(composio, ({ sessionId }) => {
        const file = this.projectApps(apiKey), own = file.people[person];
        if (!own || own.userId !== record.userId) return;
        file.people[person] = { ...own, sessionId };
        this.write("project-apps.json", file);
      });
    }
    composio.apiKey = apiKey;
    return { composio };
  }
  private async ensureProjectAccess(person: string, email: string, apiKey: string): Promise<ProjectAccess | null> {
    const userId = memberComposioUser(this.options.teamId!, person);
    if (this.projectApps(apiKey).removals.includes(userId)) await this.removeLeftUser(apiKey, userId);
    const file = this.projectApps(apiKey), held = file.people[person];
    if (!held || held.again) {
      file.people[person] = { email, userId, ...(held?.sessionId ? { sessionId: held.sessionId } : {}) };
      this.write("project-apps.json", file);
      this.remember(person, email);
    }
    return this.projectAccess(person, apiKey);
  }
  private async removeLeftUser(apiKey: string, userId: string): Promise<void> {
    await removeUserConnections(apiKey, userId);
    const file = this.projectApps(apiKey);
    if (!file.removals.includes(userId)) return;
    file.removals = file.removals.filter((left) => left !== userId);
    this.write("project-apps.json", file);
  }
  /** Removes what people who left still have connected in the team's project; a failure waits for the next call. */
  async finishRemovals(): Promise<void> {
    const apiKey = this.projectKey();
    if (!apiKey) return;
    for (const userId of this.projectApps(apiKey).removals) {
      await this.removeLeftUser(apiKey, userId).catch((error: unknown) => {
        console.warn(`[team connections] a member who left still has connections in the team's Composio project (${userId}): ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
  /** Whether the person connected apps where the team's apps no longer go (the connected-apps service before the team
   * saved its own key, or the reverse, or another project): nothing carries over, so they connect again. */
  appsElsewhere(person: string): boolean {
    const apiKey = this.projectKey();
    if (apiKey) {
      const record = this.projectApps(apiKey).people[person];
      return record ? record.again === true : Boolean(this.stored("apps.json", appsSchema)?.people[person]);
    }
    return !this.appsAccess(person) && Boolean(this.stored("project-apps.json", projectAppsSchema)?.people[person]);
  }
  /** How many members' installations are still on the connected-apps service while the team uses its own key. */
  appsLeftOnService(): number {
    return this.projectKey() ? Object.keys(this.stored("apps.json", appsSchema)?.people ?? {}).length : 0;
  }

  /** The member's own apps, when they have connected any: their Composio user in the team's project while the team has
   * its own key, else their installation on the connected-apps service. */
  appsAccess(person: string): PersonAppsAccess | null {
    const apiKey = this.projectKey();
    return apiKey ? this.projectAccess(person, apiKey) : this.serviceAccess(person);
  }
  private serviceAccess(person: string): BrokerAccess | null {
    const file = this.apps(), record = file.people[person];
    return record ? managedComposioAccess(file.brokerUrl, { composioBrokerToken: record.token }) : null;
  }
  /** The member's own apps, made now if they have none (the first time they connect an app). */
  ensureAppsAccess(person: string, email: string): Promise<PersonAppsAccess | null> {
    if (!PERSON.test(person)) return Promise.resolve(null);
    const apiKey = this.projectKey();
    if (apiKey) return this.ensureProjectAccess(person, email, apiKey);
    const held = this.serviceAccess(person);
    if (held) return Promise.resolve(held);
    const brokerUrl = this.options.brokerUrl();
    if (!brokerUrl) return Promise.resolve(null);
    const pending = this.registering.get(person);
    if (pending) return pending;
    const made = (async () => {
      const credentials: { composioBrokerToken?: string; composioInstallationId?: string } = {};
      await ensureManagedComposioCredentials({
        brokerUrl, credentials, fetchImpl: this.options.fetchImpl,
        saveCredentials: (next) => {
          if (!next.composioBrokerToken || !next.composioInstallationId) return;
          const file = this.apps();
          file.people[person] = { email, installationId: next.composioInstallationId, token: next.composioBrokerToken };
          this.write("apps.json", { ...file, brokerUrl });
          this.remember(person, email);
        },
      });
      return this.serviceAccess(person);
    })().finally(() => this.registering.delete(person));
    this.registering.set(person, made);
    return made;
  }
  /** Everyone with apps of their own, with their address (for "who has connected"). */
  appsPeople(): Array<{ person: string; email: string; access: PersonAppsAccess }> {
    const apiKey = this.projectKey();
    if (apiKey) {
      return Object.entries(this.projectApps(apiKey).people).flatMap(([person, record]) => {
        const access = this.projectAccess(person, apiKey);
        return access ? [{ person, email: record.email, access }] : [];
      });
    }
    const file = this.apps();
    return Object.entries(file.people).flatMap(([person, record]) => {
      const access = managedComposioAccess(file.brokerUrl, { composioBrokerToken: record.token });
      return access ? [{ person, email: record.email, access }] : [];
    });
  }

  key(person: string, name: string, url: string): PersonKey | null {
    const held = this.keys().people[person]?.servers[name];
    return held && held.url === url ? held : null;
  }
  putKey(person: string, email: string, name: string, key: PersonKey): void {
    if (!PERSON.test(person)) throw new Error("invalid person");
    const file = this.keys();
    const own = file.people[person] ?? { email, servers: {} };
    file.people[person] = { email, servers: { ...own.servers, [name]: key } };
    this.write("mcp-keys.json", file);
    this.remember(person, email);
    this.options.onChanged?.(person, "mcp", name);
  }
  /** The member started connecting their own app. */
  appConnecting(person: string, slug: string): void {
    this.options.onChanged?.(person, "app", slug);
  }
  deleteKey(person: string, name: string): void {
    const file = this.keys();
    if (!file.people[person]?.servers[name]) return;
    delete file.people[person]!.servers[name];
    this.write("mcp-keys.json", file);
  }
  /** Who added their own key to a server at this address. */
  keyPeople(name: string, url: string): Array<{ person: string; email: string }> {
    return Object.entries(this.keys().people).flatMap(([person, record]) => record.servers[name]?.url === url ? [{ person, email: record.email }] : []);
  }

  /** The member's own MCP sign-ins: a manager of their own, so flows and tokens never meet another person's. */
  oauth(person: string): McpOAuthManager {
    if (!PERSON.test(person)) throw new Error("invalid person");
    let manager = this.managers.get(person);
    if (!manager) {
      this.ensureDir();
      manager = new McpOAuthManager({
        file: join(this.dir, "mcp-oauth", `${person}.json`), clients: this.options.clients, isOwnerLive: this.options.isOwnerLive,
        onSettled: (name: string, phase: McpSignInPhase, owner: string) => {
          if (phase === "succeeded") this.options.onChanged?.(person, "mcp", name);
          this.options.onSettled?.(name, phase, owner);
        },
        ...(this.options.onRefresh ? { onRefresh: (name: string, outcome: McpRefreshOutcome) => this.options.onRefresh?.(person, name, outcome) } : {}),
      });
      this.managers.set(person, manager);
    }
    return manager;
  }
  /** The member's own sign-in and key for a personal server, to test it as them. */
  connection(person: string, name: string, url: string): { oauth: McpOAuthManager; key?: PersonKey } {
    const key = this.key(person, name, url);
    return { oauth: this.oauth(person), ...(key ? { key } : {}) };
  }
  /** Managers with a flow that may be waiting for its callback (made in this process). */
  liveManagers(): McpOAuthManager[] {
    return [...this.managers.values()];
  }
  /** Everyone who signed in to a server at this address. */
  signedInPeople(name: string, url: string): Array<{ person: string; email: string }> {
    const folder = join(this.dir, "mcp-oauth");
    if (!existsSync(folder)) return [];
    return readdirSync(folder).flatMap((file) => {
      const person = file.replace(/\.json$/, "");
      if (!PERSON.test(person) || !file.endsWith(".json")) return [];
      return this.oauth(person).authState(name, url) === "signed-in" ? [{ person, email: this.emailOf(person) ?? "" }] : [];
    });
  }
  /** The address a person used here (who connected is shown by address; it is not a secret). */
  emailOf(person: string): string | null {
    return this.read("people.json", z.record(z.string(), z.string()), {})[person] ?? null;
  }
  remember(person: string, email: string): void {
    if (!PERSON.test(person) || !email) return;
    const file = this.read("people.json", z.record(z.string(), z.string()), {});
    if (file[person] === email) return;
    this.write("people.json", { ...file, [person]: email });
  }
  /** An MCP server was removed: every person's key and sign-in for it go too. */
  forgetServer(name: string): void {
    const file = this.keys();
    let changed = false;
    for (const record of Object.values(file.people)) if (record.servers[name]) { delete record.servers[name]; changed = true; }
    if (changed) this.write("mcp-keys.json", file);
    const folder = join(this.dir, "mcp-oauth");
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder)) {
      const person = entry.replace(/\.json$/, "");
      if (PERSON.test(person)) this.oauth(person).forget(name);
    }
  }
  /** Test seam and deletion: everything a person connected here. What they connected in the team's own Composio project
   * is removed there too, at once when Composio answers, else by `finishRemovals`. */
  async forgetPerson(person: string): Promise<void> {
    const apps = this.apps();
    if (apps.people[person]) { delete apps.people[person]; this.write("apps.json", apps); }
    const project = this.stored("project-apps.json", projectAppsSchema);
    const left = project?.people[person];
    if (project && left) {
      delete project.people[person];
      this.write("project-apps.json", { ...project, removals: [...new Set([...project.removals, left.userId])] });
      this.projectUsers.delete(person);
    }
    const keys = this.keys();
    if (keys.people[person]) { delete keys.people[person]; this.write("mcp-keys.json", keys); }
    this.managers.get(person)?.dispose();
    this.managers.delete(person);
    rmSync(join(this.dir, "mcp-oauth", `${person}.json`), { force: true });
    if (left) await this.finishRemovals();
  }
}

/** A member's key as the header the server expects: the header an admin's key used, else Authorization, as a bearer. */
export function personKeyHeader(teamHeaders: readonly string[], value: string): { header: string; value: string } {
  const header = teamHeaders[0] ?? "Authorization";
  const trimmed = value.trim();
  return { header, value: header.toLowerCase() === "authorization" && !/^\w+\s/.test(trimmed) ? `Bearer ${trimmed}` : trimmed };
}
