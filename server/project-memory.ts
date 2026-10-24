import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { canonicalJson } from "../shared/package-format.ts";
import { readSections, sectionMemoryKey } from "./section-context.ts";
import { TEAM_MEMORY_KINDS, TeamMemory, type TeamMemoryEntry, type TeamMemoryScope } from "./team-memory.ts";

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const projectSchema = z.object({
  id: idSchema,
  sectionKey: z.string().min(1).max(256),
  root: z.string().min(1).max(4096),
  memberBotIds: z.array(idSchema).min(1).max(1000),
}).strict();

/** Operator policy binds a stable native section identity and explicit membership to one physical project root. */
export const projectMemoryPolicySchema = z.object({ version: z.literal(1), projects: z.array(projectSchema).max(1000) }).strict();
export type ProjectMemoryProject = z.infer<typeof projectSchema>;

export function readProjectMemoryProjects(file: string): ProjectMemoryProject[] {
  let fd: number | undefined;
  try {
    if (!lstatSync(file).isFile()) throw new Error("Project-memory policy must be a regular file");
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024 || (process.getuid && stat.uid !== process.getuid())
      || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Project-memory policy must be private and owner controlled");
    return projectMemoryPolicySchema.parse(JSON.parse(readFileSync(fd, "utf8"))).projects;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ProjectMemoryError(503, "unavailable", "Project-memory policy is unavailable or invalid.");
  } finally { if (fd !== undefined) closeSync(fd); }
}

export const projectMemoryRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("recall"), query: z.string().max(500).default(""),
    entryId: idSchema.optional(), revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    limit: z.number().int().min(1).max(25).default(12) }).strict(),
  z.object({ operation: z.literal("remember"), kind: z.enum(TEAM_MEMORY_KINDS), key: z.string().max(240).optional(),
    name: z.string().min(1).max(120), detail: z.string().min(1).max(600),
    aliases: z.array(z.string().min(1).max(120)).max(8).optional() }).strict(),
  z.object({ operation: z.literal("forget"), entryId: idSchema, revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);

export interface ProjectMemoryCaller { botId: string; threadId: string }

/** Recomputed from current server-owned records, never from an agent's tool arguments or message text. */
export interface ProjectMemoryContext extends ProjectMemoryCaller {
  botName: string;
  section?: string;
  cwd: string;
  canApply: boolean;
  messageId?: string;
  turnId?: string;
  assignmentId?: string;
  rootJobId?: string;
  audience?: Array<{ botId: string; section?: string }>;
}

export interface ProjectMemoryOptions {
  memory: Pick<TeamMemory, "list" | "search" | "propose" | "resolve" | "remove">;
  projects(): readonly ProjectMemoryProject[];
  context(caller: ProjectMemoryCaller): ProjectMemoryContext | undefined;
  sections?(): readonly string[];
  sectionKey?(section: string): string;
  now?(): number;
}

export class ProjectMemoryError extends Error {
  readonly status: number;
  readonly code: "invalid" | "forbidden" | "unavailable" | "missing";
  constructor(status: number, code: ProjectMemoryError["code"], message: string) {
    super(message);
    this.name = "ProjectMemoryError";
    this.status = status;
    this.code = code;
  }
}

const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const denied = (): never => { throw new ProjectMemoryError(403, "forbidden", "This conversation has no current project-memory grant for its assigned working directory."); };

function physicalDirectory(path: string): string | undefined {
  try {
    if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !statSync(path).isDirectory()) return undefined;
    return path;
  } catch { return undefined; }
}

function contains(root: string, cwd: string): boolean {
  const child = relative(root, cwd);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

/** A local, noncanonical projection in the native memory file; it never calls or promotes into Kanister or another backend. */
export class ProjectMemory {
  private readonly options: ProjectMemoryOptions;
  constructor(options: ProjectMemoryOptions) { this.options = options; }

  private authorize(caller: ProjectMemoryCaller): { context: ProjectMemoryContext; project: ProjectMemoryProject; scope: TeamMemoryScope } {
    if (!idSchema.safeParse(caller.botId).success || !idSchema.safeParse(caller.threadId).success) return denied();
    const context = this.options.context(caller);
    const sections = (this.options.sections ?? readSections)();
    if (!context || context.botId !== caller.botId || context.threadId !== caller.threadId || !context.section
      || !sections.includes(context.section)) return denied();
    const keyForSection = this.options.sectionKey ?? sectionMemoryKey;
    const sectionKey = keyForSection(context.section);
    let projects: ProjectMemoryProject[];
    try {
      projects = projectMemoryPolicySchema.parse({ version: 1, projects: this.options.projects() }).projects;
      if (new Set(projects.map(project => project.id)).size !== projects.length) throw new Error("duplicate project id");
    } catch {
      throw new ProjectMemoryError(503, "unavailable", "Project-memory policy is unavailable or invalid.");
    }
    const cwd = physicalDirectory(context.cwd);
    if (!cwd) return denied();
    const matching = projects.filter(project => project.sectionKey === sectionKey && project.memberBotIds.includes(caller.botId)
      && physicalDirectory(project.root) === project.root && contains(project.root, cwd)
      && (context.audience ?? []).every(member => member.section && sections.includes(member.section)
        && keyForSection(member.section) === project.sectionKey && project.memberBotIds.includes(member.botId)));
    // Overlapping grants are ambiguous; do not choose a namespace by request order or a model-provided project id.
    if (matching.length !== 1) return denied();
    const project = matching[0];
    return { context, project, scope: { projectId: digest({ id: project.id, sectionKey: project.sectionKey, root: project.root }) } };
  }

  request(caller: ProjectMemoryCaller, input: unknown) {
    const parsed = projectMemoryRequestSchema.safeParse(input);
    if (!parsed.success) {
      const problems = parsed.error.issues.slice(0, 5).map(issue => {
        if (issue.code === "unrecognized_keys") return "Unexpected fields; scope and provenance are assigned by the server";
        const value = issue.path.length === 1 && input !== null && typeof input === "object"
          ? (input as Record<PropertyKey, unknown>)[issue.path[0]!] : undefined;
        const received = issue.code === "too_big" && typeof value === "string" ? ` (received ${value.length} characters)` : "";
        return `${issue.path.join(".") || "request"}: ${issue.message}${received}`;
      });
      throw new ProjectMemoryError(400, "invalid", `Invalid project-memory request. ${problems.join("; ")}. Nothing was saved.`);
    }
    const { context, project, scope } = this.authorize(caller);
    const request = parsed.data;
    const envelope = { schema: "openmaus.project-memory.v1" as const, provider: "openmaus-native-local" as const,
      canonical: false as const, promoted: false as const, untrusted_context: true as const,
      project: { id: project.id, root: project.root, sectionKey: project.sectionKey },
      principal: { botId: context.botId, threadId: context.threadId },
      boundary: "Native project-memory API and tool scope; this is not an operating-system filesystem sandbox." };
    if (request.operation === "recall") {
      const current = request.entryId
        ? this.options.memory.list(scope).filter(entry => entry.status === "accepted" && entry.id === request.entryId)
        : this.options.memory.search(scope, request.query, request.limit);
      const entries = current.filter(entry => request.revision === undefined || entry.revision === request.revision);
      return { ...envelope, operation: request.operation, state: "recalled" as const, no_relevant_memory: entries.length === 0, entries };
    }
    if (!context.canApply) {
      throw new ProjectMemoryError(403, "forbidden", "Project-memory writes require the existing direct user-driven authorization; nothing was saved.");
    }
    if (request.operation === "forget") {
      if (!this.options.memory.remove(scope, request.entryId, request.revision)) {
        throw new ProjectMemoryError(404, "missing", "No current project-memory entry matches that id.");
      }
      return { ...envelope, operation: request.operation, state: "forgotten" as const, entryId: request.entryId };
    }
    const { operation: _operation, ...inputEntry } = request;
    const normalized = TeamMemory.normalize(inputEntry);
    const proposed = this.options.memory.propose(scope, normalized, {
      botId: context.botId, botName: context.botName, threadId: context.threadId, at: (this.options.now ?? Date.now)(),
      ...(context.messageId ? { messageId: context.messageId } : {}), ...(context.turnId ? { turnId: context.turnId } : {}),
      project: { id: project.id, root: project.root, sectionKey: project.sectionKey,
        ...(context.assignmentId ? { assignmentId: context.assignmentId } : {}), ...(context.rootJobId ? { rootJobId: context.rootJobId } : {}) },
    });
    try { this.options.memory.resolve(scope, proposed.entry.id, "accept", proposed.entry.revision); }
    catch (error) { this.options.memory.resolve(scope, proposed.entry.id, "reject"); throw error; }
    const entry = this.options.memory.list(scope).find(candidate => candidate.id === proposed.entry.id)!;
    return { ...envelope, operation: request.operation, state: "remembered" as const, entry,
      undo: { operation: "forget" as const, entryId: entry.id, revision: entry.revision! }, contentHash: this.contentHash(entry) };
  }

  private contentHash(entry: TeamMemoryEntry): string {
    return digest({ kind: entry.kind, name: entry.name, detail: entry.detail, aliases: entry.aliases, key: entry.key });
  }
}
