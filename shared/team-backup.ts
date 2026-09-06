import { z } from "zod";

export const MAX_TEAM_BACKUP_BYTES = 50 * 1024 * 1024;
export const TEAM_BACKUP_CONTENTS = "Bot profiles, instructions, sections, rooms, playbooks, routines and conversation text (all tasks and branches).";
export const TEAM_BACKUP_EXCLUSIONS = "Files, images, custom avatars, workspace memory, account connections, model settings and permissions are not included. Action cards are saved as text. Imported routines start paused.";

const key = z.string().min(1).max(200);
const name = z.string().trim().min(1).max(200);
const timestamp = z.number().finite().nonnegative();
const color = z.enum(["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"]);
const message = z.object({
  id: key,
  role: z.enum(["bot", "user"]),
  text: z.string().max(2_000_000),
  at: timestamp,
  parentId: key.nullable(),
  replyToId: key.optional(),
  from: z.object({ botId: key, name, color: z.string().max(40) }).optional(),
  peerPost: z.object({ unattended: z.boolean().optional() }).optional(),
});
const task = z.object({
  key,
  title: z.string().max(2_000),
  createdAt: timestamp,
  activeLeafId: key.nullable(),
  messages: z.array(message).max(100_000),
});
const owner = {
  key,
  name,
  section: z.string().max(200).optional(),
  activeTask: key,
  tasks: z.array(task).min(1).max(10_000),
};
const playbook = z.object({
  key, name, summary: z.string().max(24_000),
  triggers: z.array(z.string().max(2_000)).max(100),
  instructions: z.string().max(200_000),
});
const schedule = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: timestamp }),
  z.object({ type: z.literal("daily"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }),
  z.object({ type: z.literal("interval"), everyMinutes: z.number().int().min(5).max(1440), anchorAt: z.number().int().min(0).max(8_640_000_000_000_000) }),
]);
const backupSchema = z.object({
  format: z.literal("openmaus.backup"),
  version: z.literal(1),
  name,
  exportedAt: timestamp,
  warnings: z.array(z.string().max(2_000)).max(4_000).default([]),
  bots: z.array(z.object({
    ...owner,
    title: z.string().max(2_000),
    description: z.string().max(200_000),
    // Same UTF-8 limit as the profile editor (this schema also runs in the browser).
    soul: z.string().refine((value) => new TextEncoder().encode(value).byteLength <= 24_000, {
      error: "standing instructions must be at most 24000 bytes",
    }).optional(),
    color,
    mascotExpression: z.string().max(80).optional(),
    mascotBody: z.string().max(40).optional(),
    chiefOfStaff: z.boolean(),
    hidden: z.boolean(),
    playbooks: z.array(playbook).max(200),
  })).min(1).max(200),
  groups: z.array(z.object({
    ...owner,
    memberIds: z.array(key).max(200),
    dm: z.boolean(),
    bulletin: z.string().max(200_000),
    defaultResponder: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("member"), botId: key }),
      z.object({ kind: z.literal("everyone") }),
      z.object({ kind: z.literal("mentions") }),
    ]),
  })).max(2_000),
  routines: z.array(z.object({
    name, prompt: z.string().trim().min(1).max(200_000),
    target: z.enum(["bot", "room-goal"]), botId: key, groupId: key.optional(),
    runOn: z.enum(["maus", "cloud"]), schedule,
    durationMinutes: z.number().finite().positive(),
    timeoutMinutes: z.number().int().min(5).max(240).optional(),
  })).max(2_000),
});

export type TeamBackup = z.infer<typeof backupSchema>;
export type BackupTask = z.infer<typeof task>;

/** Validate the whole reference graph before an import can write anything.
 * All keys are file-local; none are ever used as destination record IDs. */
export function parseTeamBackup(input: unknown): TeamBackup {
  const parsed = backupSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid backup: ${issue.path.join(".") || "file"}: ${issue.message}`);
  }
  const backup = parsed.data;
  const unique = (keys: string[], label: string) => {
    const set = new Set(keys);
    if (set.size !== keys.length) throw new Error(`Invalid backup: duplicate ${label}`);
    return set;
  };
  const bots = unique(backup.bots.map((bot) => bot.key), "bot key");
  const groups = unique(backup.groups.map((group) => group.key), "room key");
  const chiefs = new Set<string>();
  for (const bot of backup.bots) {
    if (!bot.chiefOfStaff) continue;
    // Persisted section identity is its exact trimmed display label.
    const section = bot.section?.trim() ?? "";
    if (chiefs.has(section) || bot.hidden) throw new Error("Invalid backup: a section must have at most one visible Chief of Staff");
    chiefs.add(section);
  }
  for (const group of backup.groups) {
    if (group.memberIds.some((id) => !bots.has(id))) throw new Error("Invalid backup: unknown room member");
    unique(group.memberIds, "room member");
    if (group.defaultResponder.kind === "member" && !group.memberIds.includes(group.defaultResponder.botId)) {
      throw new Error("Invalid backup: room responder is not a member");
    }
    if (group.dm && (group.memberIds.length !== 2 || group.tasks.length !== 1)) throw new Error("Invalid backup: invalid direct-message room");
  }
  for (const routine of backup.routines) {
    if (!bots.has(routine.botId)) throw new Error("Invalid backup: unknown routine bot");
    if (routine.target === "room-goal") {
      if (routine.runOn !== "maus") throw new Error("Invalid backup: room goals must run on this computer");
      const group = backup.groups.find((candidate) => candidate.key === routine.groupId);
      if (!groups.has(routine.groupId ?? "") || !group || group.dm || !group.memberIds.includes(routine.botId)) {
        throw new Error("Invalid backup: unknown routine room or coordinator");
      }
    }
  }
  for (const entry of [...backup.bots, ...backup.groups]) {
    const tasks = unique(entry.tasks.map((task) => task.key), "task key");
    if (!tasks.has(entry.activeTask)) throw new Error("Invalid backup: unknown active task");
    for (const task of entry.tasks) {
      const messages = unique(task.messages.map((message) => message.id), "message key");
      const seen = new Set<string>();
      for (const message of task.messages) {
        // Parents must precede children: rejects cycles and dangling branches.
        if (message.parentId !== null && !seen.has(message.parentId)) throw new Error("Invalid backup: invalid conversation branch");
        if (message.replyToId && !messages.has(message.replyToId)) throw new Error("Invalid backup: unknown reply");
        seen.add(message.id);
      }
      if (task.activeLeafId !== null && !messages.has(task.activeLeafId)) throw new Error("Invalid backup: unknown conversation head");
    }
  }
  return backup;
}
