// What this server remembers about the computers lent to it, so the person and their bots can tell "lent but offline
// since Tuesday" from "never lent", across restarts: a name, its platform, what it lends, when it was last online and
// last used, and whether its owner stopped lending. Never a folder path, a credential or anything a job carried.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import { useMyComputerLink } from "../shared/use-my-computer.ts";
import { writeFileAtomic } from "./atomic.ts";

export const LENT_PLATFORMS = ["darwin", "win32", "linux"] as const;
export type LentPlatform = typeof LENT_PLATFORMS[number];

const recordSchema = z.object({
  id: z.string().uuid(), person: z.string().min(1).max(200), name: z.string().min(1).max(120), platform: z.enum(LENT_PLATFORMS).nullable(),
  folders: z.number().int().min(0).max(20), terminal: z.boolean(), screen: z.boolean(), internet: z.boolean().optional(), chrome: z.boolean().optional(),
  lastSeenAt: z.number(), lastUsedAt: z.number().nullable(), stoppedAt: z.number().nullable(),
}).strict();
const fileSchema = z.object({ version: z.literal(1), computers: z.array(recordSchema).max(200) });
export type LentComputer = z.infer<typeof recordSchema>;

const KEEP_MS = 90 * 24 * 60 * 60_000;
const SEEN_WRITE_MS = 60_000;
const PER_PERSON = 10;

/** "PC" on Windows, "Mac" on macOS, else "computer": the word a bot uses for the person's device. */
export function deviceWord(platform: LentPlatform | null | undefined): "PC" | "Mac" | "computer" {
  return platform === "win32" ? "PC" : platform === "darwin" ? "Mac" : "computer";
}

export class LentComputers {
  private readonly file: string;
  private readonly now: () => number;
  private computers: LentComputer[] = [];
  private written = new Map<string, number>();

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    try {
      if (existsSync(file)) this.computers = fileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).computers;
    } catch {
      // A record that cannot be read only loses history; lending itself does not depend on it.
      console.warn("lending: the record of lent computers could not be read; starting a new one");
    }
  }

  private save(): void {
    const cutoff = this.now() - KEEP_MS;
    this.computers = this.computers.filter((computer) => computer.lastSeenAt >= cutoff);
    try { writeFileAtomic(this.file, `${JSON.stringify({ version: 1, computers: this.computers })}\n`, { mode: 0o600 }); }
    catch (error) { console.warn(`lending: could not save the record of lent computers: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private find(person: string, id: string): LentComputer | undefined {
    return this.computers.find((computer) => computer.person === person && computer.id === id);
  }

  /** A computer that registered, now lending these scopes. Each new grant has a new id, so a computer is known by its
   * name: lending again from the same computer updates its one record. A person's newest computers are kept. */
  connected(person: string, input: { id: string; name: string; platform?: LentPlatform; folders: number; terminal: boolean; screen: boolean; internet?: boolean; chrome?: boolean }): void {
    const at = this.now();
    const same = (computer: LentComputer) => computer.person === person && (computer.id === input.id || computer.name === input.name);
    const previous = this.computers.find(same);
    const next: LentComputer = { id: input.id, person, name: input.name, platform: input.platform ?? previous?.platform ?? null, folders: input.folders,
      terminal: input.terminal, screen: input.screen, internet: input.internet === true, chrome: input.chrome === true, lastSeenAt: at, lastUsedAt: previous?.lastUsedAt ?? null, stoppedAt: null };
    const others = this.computers.filter((computer) => !same(computer));
    const mine = [next, ...others.filter((computer) => computer.person === person)].slice(0, PER_PERSON);
    this.computers = [...mine, ...others.filter((computer) => computer.person !== person)];
    this.written.set(`${person}\n${input.id}`, at);
    this.save();
  }

  /** It polled: written at most once a minute, so "last online" is never more than a minute behind. */
  seen(person: string, id: string): void {
    const computer = this.find(person, id);
    if (!computer) return;
    const at = this.now();
    computer.lastSeenAt = at;
    const key = `${person}\n${id}`;
    if (at - (this.written.get(key) ?? 0) < SEEN_WRITE_MS) return;
    this.written.set(key, at);
    this.save();
  }

  used(person: string, id: string): void {
    const computer = this.find(person, id);
    if (!computer) return;
    computer.lastUsedAt = computer.lastSeenAt = this.now();
    this.save();
  }

  /** Its owner turned lending off on that computer: it is no longer lent, not merely offline. */
  stopped(person: string, id: string): void {
    const computer = this.find(person, id);
    if (!computer) return;
    computer.stoppedAt = computer.lastSeenAt = this.now();
    this.save();
  }

  list(person: string | null): LentComputer[] {
    if (!person) return [];
    return this.computers.filter((computer) => computer.person === person).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
}

/** How the person lends apps and screen: one link, pressed in OpenMausBot on the lent computer, which asks them once. */
export const lendScreenSteps = (device: "PC" | "Mac" | "computer") => `To lend them, give the person ${useMyComputerLink(device)} to press in OpenMausBot `
  + `on that ${device}: it asks them once and turns on its apps and screen.`;

const dateText = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * What list_shared_computers adds for a bot when a computer it knows is not online: the computer by name and kind, since
 * when, and the one sentence to say. Nothing when every known computer is online.
 */
export function awayNotice(known: LentComputer[], online: ReadonlySet<string>): { offline?: Array<{ name: string; device: string; lastOnline: string; lent: boolean }>; say?: string } {
  const away = known.filter((computer) => !online.has(computer.id));
  if (!away.length || known.some((computer) => online.has(computer.id))) return {};
  const offline = away.slice(0, 3).map((computer) => ({ name: computer.name, device: deviceWord(computer.platform), lastOnline: dateText(computer.lastSeenAt), lent: computer.stoppedAt === null }));
  const latest = away[0]!;
  const device = deviceWord(latest.platform);
  const say = latest.stoppedAt === null
    ? `Their ${device} ${latest.name} is shared with the Cloud but offline (last online ${dateText(latest.lastSeenAt)}): OpenMausBot on it is closed, or the ${device} is asleep or off. Ask them to open OpenMausBot on that ${device}; it reconnects by itself.`
    : `Their ${device} ${latest.name} is no longer shared with the Cloud: sharing was turned off on it. To share it again, they press ${useMyComputerLink(device)} in OpenMausBot on that ${device}.`;
  return { offline, say };
}
