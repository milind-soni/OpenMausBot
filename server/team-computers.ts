import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

export const teamComputerCreate = z.object({
  name: z.string().trim().min(1).max(60).refine(value => [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)),
  acknowledgeCost: z.literal(true),
  // Clients may keep this id across a lost create response. It is not a Box id.
  requestId: z.string().uuid(),
}).strict();
export const teamComputerAssignment = z.object({
  section: z.string().trim().max(60).nullable(),
  acknowledgeSharedAccess: z.literal(true),
}).strict();
const entrySchema = z.object({
  id: z.string().uuid(), name: teamComputerCreate.shape.name,
  section: z.string().trim().max(60).nullable(), createdAt: z.number().finite().nonnegative(),
  problem: z.string().max(500).optional(),
}).strict();
const fileSchema = z.object({ version: z.literal(1), environmentId: z.string().uuid(), computers: z.array(entrySchema).max(100) }).strict();
export type TeamComputerRecord = z.infer<typeof entrySchema>;
export const teamComputerOwner = (id: string): string => `computer_${id}`;
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });

/** One server writer owns the data directory. Persist identity before any
 * provider call; failed/retried creates always retain the same Box journal key.
 * Invalid or foreign restored state is never silently reset to an empty pool. */
export class TeamComputers {
  private entries: TeamComputerRecord[] = [];
  private problem?: string;
  private readonly file: string;
  private readonly environmentId: string;
  constructor(file: string, environmentId: string) {
    this.file = file;
    this.environmentId = environmentId;
    try {
      if (!existsSync(file)) return;
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) throw new Error("unsafe registry file");
      const saved = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      if (saved.environmentId !== environmentId) throw new Error("registry belongs to another workspace; its computers were not transferred");
      if (new Set(saved.computers.map(entry => entry.id)).size !== saved.computers.length) throw new Error("duplicate computer identity");
      const sections = saved.computers.flatMap(entry => entry.section === null ? [] : [entry.section]);
      if (new Set(sections).size !== sections.length) throw new Error("a team has more than one computer");
      this.entries = saved.computers;
    } catch (error) {
      this.problem = `Team computer registry could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  list(): TeamComputerRecord[] {
    if (this.problem) throw failure(this.problem, 503);
    return this.entries.map(entry => ({ ...entry }));
  }
  get(id: string): TeamComputerRecord | undefined { return this.list().find(entry => entry.id === id); }
  forSection(section: string | undefined): TeamComputerRecord | undefined {
    return this.list().find(entry => entry.section !== null && entry.section === (section?.trim() || ""));
  }
  forBot(bot: { computer?: string; cloudBackend?: string; section?: string }): TeamComputerRecord | undefined {
    // Explicit destinations are permissions, not suggestions. Only Auto inherits.
    return bot.computer === undefined && bot.cloudBackend !== "vps" ? this.forSection(bot.section) : undefined;
  }
  create(name: string, id: string = randomUUID()): TeamComputerRecord {
    const entries = this.list();
    const existing = entries.find(entry => entry.id === id);
    if (existing) {
      if (existing.name !== name) throw failure("This creation id already names a different computer");
      return existing;
    }
    if (entries.length >= 100) throw failure("This workspace has reached its team computer limit");
    const entry = entrySchema.parse({ id, name, section: null, createdAt: Date.now() });
    this.save([...entries, entry]);
    return { ...entry };
  }
  assign(id: string, section: string | null): TeamComputerRecord {
    section = entrySchema.shape.section.parse(section);
    const entry = this.get(id);
    if (!entry) throw failure("No such team computer", 404);
    if (entry.section !== null && section !== null && section !== entry.section) throw failure("Unassign this computer before moving it to another team");
    if (section !== null && this.list().some(other => other.id !== id && other.section === section)) throw failure("This team already has a computer; unassign it first");
    return this.patch(id, { section });
  }
  setProblem(id: string, problem?: string): TeamComputerRecord {
    return this.patch(id, { problem: problem?.slice(0, 500) });
  }
  /** Relabel an existing team's assignment; this never changes its computer. */
  renameSection(from: string, to: string): boolean {
    const entry = this.forSection(from);
    if (!entry || from === to) return false;
    if (this.forSection(to)) throw failure("This team already has a computer");
    this.patch(entry.id, { section: to });
    return true;
  }
  private patch(id: string, patch: Partial<TeamComputerRecord>): TeamComputerRecord {
    const entries = this.list();
    const entry = entries.find(candidate => candidate.id === id);
    if (!entry) throw failure("No such team computer", 404);
    const next = entrySchema.parse({ ...entry, ...patch });
    this.save(entries.map(candidate => candidate.id === id ? next : candidate));
    return { ...next };
  }
  private save(entries: TeamComputerRecord[]): void {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, environmentId: this.environmentId, computers: entries }), { mode: 0o600 });
    this.entries = entries;
  }
}
