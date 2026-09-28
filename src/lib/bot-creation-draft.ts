import type { NewBotDefaults, BotDefaultsProfile, BotRoutineTemplate } from "../../shared/new-bot-defaults";
import { api, type Bot, type ModelSelection } from "@/state/store";
import type { BotUpdatePatch } from "@/state/bot-patch-queue";
import type { Routine, RoutineInput } from "./routines";
import type { ChosenPreset } from "./bot-presets";

export const EMPTY_BOT_DEFAULTS: NewBotDefaults = { profile: {}, memory: {}, skills: [], routines: [] };

const routineTemplate = (routine: Routine): BotRoutineTemplate => ({
  name: routine.name, prompt: routine.prompt, schedule: routine.schedule,
  enabled: routine.enabled, runOn: routine.runOn, durationMinutes: routine.durationMinutes,
  timeoutMinutes: routine.timeoutMinutes, overlap: routine.overlap,
  attachments: routine.attachments,
});

/** One dialog owns one draft. No workspace writes or synthetic bots in the
 * global store; even an unsupported child request fails closed locally. */
export class BotCreationDraft {
  readonly id = `draft-${crypto.randomUUID()}`;
  template: NewBotDefaults;
  consent: Pick<BotUpdatePatch, "confirmFullAccess" | "acknowledgeLocalAuto"> & { acknowledgePeerScope?: boolean } = {};
  routines: Routine[];
  /** A preset chosen in New bot: the server adds its skills and notes. */
  preset?: ChosenPreset;
  avatarFile?: File;
  private avatarObjectUrl?: string;

  constructor(defaults: NewBotDefaults, readonly changed: () => void, private network: typeof api = api) {
    this.template = structuredClone(defaults);
    this.routines = defaults.routines.map(routine => this.routine({ ...routine, botId: this.id }));
  }

  get bot(): Bot {
    const { computer, cwd, peers, ...profile } = this.template.profile;
    return {
      id: this.id, threadId: this.id, name: "", title: "", description: "", soul: "",
      color: "green", notifications: true, unread: false, messages: [],
      modelSelection: { instanceId: "", model: "" }, ...profile,
      computer: computer ?? undefined, cwd: cwd ?? undefined, peers: peers ?? undefined,
    };
  }

  patch(value: BotUpdatePatch & Partial<BotDefaultsProfile> & { acknowledgePeerScope?: boolean }) {
    const { confirmFullAccess, acknowledgeLocalAuto, acknowledgePeerScope, applyToAllThreads: _all,
      autoApprove, ...profile } = value;
    if (confirmFullAccess !== undefined) this.consent.confirmFullAccess = confirmFullAccess;
    if (acknowledgeLocalAuto !== undefined) this.consent.acknowledgeLocalAuto = acknowledgeLocalAuto;
    if (acknowledgePeerScope !== undefined) this.consent.acknowledgePeerScope = acknowledgePeerScope;
    if (autoApprove !== undefined && profile.approvalMode === undefined) profile.approvalMode = autoApprove ? "auto" : "ask";
    this.template.profile = { ...this.template.profile, ...profile };
    this.changed();
  }

  setModel(modelSelection: ModelSelection) { this.patch({ modelSelection }); }

  /** Remember (or forget) the preset New bot started from. */
  choosePreset(preset: ChosenPreset | undefined) {
    this.preset = preset;
    this.changed();
  }

  setMemory(path: string, text: string | null) {
    if (text === null) delete this.template.memory[path];
    else this.template.memory[path] = text;
    this.changed();
  }

  setRoutineEnabled(id: string, enabled: boolean) {
    this.routines = this.routines.map(routine => routine.id === id ? { ...routine, enabled } : routine);
    this.changed();
  }

  removeRoutine(id: string) {
    this.routines = this.routines.filter(routine => routine.id !== id);
    this.changed();
  }

  export(): NewBotDefaults { return structuredClone({ ...this.template, routines: this.routines.map(routineTemplate) }); }

  uploadAvatar = async (file: File): Promise<string> => {
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPEG, GIF, or WebP image");
    if (file.size > 10 * 1024 * 1024) throw new Error("Choose an image smaller than 10 MiB");
    if (this.avatarObjectUrl) URL.revokeObjectURL(this.avatarObjectUrl);
    this.avatarFile = file;
    this.avatarObjectUrl = URL.createObjectURL(file);
    return this.avatarObjectUrl;
  };

  dispose() { if (this.avatarObjectUrl) URL.revokeObjectURL(this.avatarObjectUrl); }

  private routine(input: RoutineInput, previous?: Routine): Routine {
    const { groupId: _group, resultsThreadId: _results, schedule, ...fields } = input;
    const normalizedSchedule = schedule.type === "interval" ? {
      ...schedule, weekdays: schedule.weekdays ?? undefined,
      window: schedule.window ?? undefined, endsAt: schedule.endsAt ?? undefined,
    } : schedule;
    return {
      id: previous?.id ?? `draft-${crypto.randomUUID()}`, createdAt: previous?.createdAt ?? Date.now(),
      updatedAt: Date.now(), nextRunAt: null, runOn: "maus", ...previous, ...fields,
      enabled: input.enabled ?? previous?.enabled ?? true, target: "bot", botId: this.id,
      timeoutMinutes: input.timeoutMinutes ?? undefined,
      durationMinutes: input.durationMinutes ?? previous?.durationMinutes ?? 30,
      schedule: normalizedSchedule,
    };
  }

  request: typeof api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const base = `/api/bots/${this.id}`;
    let result: unknown;
    if (path === base && method === "PATCH") {
      this.patch(body); result = { bot: this.bot };
    } else if (path === `${base}/soul` && method === "GET") {
      result = { soul: this.bot.soul, revision: "draft", bytes: new TextEncoder().encode(this.bot.soul).length, limit: 24000, file: "", drift: false };
    } else if (path === `${base}/skills` && method === "GET") {
      result = { skills: this.template.skills, staged: [] };
    } else if (path === `${base}/skills` && method === "POST") {
      const preview = await this.network<{ skills: NewBotDefaults["skills"] }>("/api/bot-defaults/skills/preview", { method: "POST", body: JSON.stringify(body) });
      const names = new Set(this.template.skills.map(skill => skill.name));
      if (preview.skills.some(skill => names.has(skill.name))) throw new Error("A skill with this name is already in the draft");
      this.template.skills.push(...preview.skills); this.changed(); result = { installed: preview.skills };
    } else if (path.startsWith(`${base}/skills/`)) {
      const name = decodeURIComponent(path.slice(`${base}/skills/`.length));
      const skill = this.template.skills.find(skill => skill.name === name);
      if (!skill) throw new Error("No such draft skill");
      if (method === "GET") result = { text: skill.text };
      else if (method === "PATCH" && typeof body.enabled === "boolean") {
        skill.enabled = body.enabled; this.changed(); result = { ok: true };
      } else if (method === "DELETE") {
        this.template.skills = this.template.skills.filter(item => item !== skill); this.changed(); result = { ok: true };
      } else throw new Error("Unsupported draft skill operation");
    } else if (path === `${base}/avatar/generate` && method === "POST") {
      const { name, title, description } = this.bot;
      const { dataUrl } = await this.network<{ dataUrl: string }>("/api/bot-defaults/avatar", {
        method: "POST", body: JSON.stringify({ profile: { name, title, description }, prompt: body.prompt }),
      });
      const blob = await (await fetch(dataUrl)).blob();
      const avatarUrl = await this.uploadAvatar(new File([blob], "avatar.png", { type: blob.type }));
      result = { avatarUrl, bot: { ...this.bot, avatarUrl, avatarCrop: "circle" } };
    } else if ((path === "/api/routines" && method === "POST") || (path.startsWith("/api/routines/draft-") && method === "PATCH")) {
      if (body.target && body.target !== "bot") throw new Error("A new bot's routine must target that bot");
      if (body.botId !== this.id) throw new Error("Routine belongs to another bot");
      const previous = this.routines.find(routine => path === `/api/routines/${routine.id}`);
      if (method === "PATCH" && !previous) throw new Error("No such draft routine");
      const routine = this.routine(body, previous);
      this.routines = [...this.routines.filter(item => item.id !== routine.id), routine];
      this.changed(); result = { routine };
    } else throw new Error("This operation requires a created bot");
    // The scoped transport implements these existing endpoint response shapes.
    return result as T;
  };
}
