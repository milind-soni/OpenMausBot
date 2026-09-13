import { createHash } from "node:crypto";
import { z } from "zod";
import { newId, type ModelSelection } from "./contracts.ts";
import { fitsOnOneLine, parseBotProfilePatch } from "./bot-profile.ts";
import { profileSnapshot } from "./profile-revision.ts";
import { redactSecretsInText } from "./redact.ts";
import type { BotRecord, OptionCardData } from "./store.ts";
import type { TeamSetupFields, TeamSetupOperation, TeamSetupRequest, TeamSetupResult } from "../shared/team-setup.ts";

const section = (value?: string) => value?.trim() || "";
const teamName = z.string().trim().min(1).max(60).refine(fitsOnOneLine).refine((value) => redactSecretsInText(value) === value, "Team names cannot contain credentials");
const fieldsSchema = z.object({
  name: z.string().optional(), title: z.string().optional(), description: z.string().optional(), soul: z.string().optional(),
  section: z.string().trim().max(60).refine(fitsOnOneLine).refine((value) => redactSecretsInText(value) === value, "Team names cannot contain credentials").optional(),
  modelSelection: z.object({ instanceId: z.string().trim().min(1), model: z.string().trim().min(1), effort: z.string().optional() }).strict().optional(),
}).strict();
const planSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  newTeams: z.array(teamName).max(8).default([]),
  operations: z.array(z.discriminatedUnion("action", [
    z.object({ action: z.literal("create"), key: z.string().trim().min(1).max(80), fields: fieldsSchema }).strict(),
    z.object({ action: z.literal("update"), botId: z.string().min(1).max(128), fields: fieldsSchema }).strict(),
  ])).min(1).max(24),
}).strict();

export class TeamSetupError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Settings relevant to approval, including the previous durable receipt. */
export function teamSetupRevision(bot: BotRecord): string {
  return createHash("sha256").update(JSON.stringify({
    ...profileSnapshot(bot), section: section(bot.section), modelSelection: bot.modelSelection,
    hidden: Boolean(bot.hidden), chiefOfStaff: Boolean(bot.chiefOfStaff), peers: bot.peers,
    managedSections: bot.managedSections,
    approvalMode: bot.approvalMode, autoApprove: bot.autoApprove, approvalGrant: bot.approvalGrant,
    receipt: bot.lastTeamSetupReceipt?.requestId,
  })).digest("hex");
}

interface SetupStore {
  bots: BotRecord[];
  bot(id: string): BotRecord | null | undefined;
  messagesFor(threadId: string): Array<{ id: string; card?: OptionCardData }>;
  appendMessage(threadId: string, message: { role: "bot"; kind: "options"; card: OptionCardData; from?: { botId: string; name: string; color: string } }): { id: string };
  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardData }): unknown;
  applyTeamSetup(request: TeamSetupRequest): TeamSetupResult;
}

interface Options {
  store: SetupStore;
  teams(): string[];
  canAccessTeam(from: BotRecord, target?: string): boolean;
  canPersist(botId: string, threadId: string): { ok: true } | { ok: false; status: number; error: string };
  validateModel(selection: ModelSelection, current?: BotRecord): string | null;
  targetBusy(botId: string): boolean;
  maxBots: number;
  ownsThread(botId: string, threadId: string): boolean;
  deleteBot(botId: string, revalidate: () => void, request: TeamSetupRequest): Promise<void>;
}

export class TeamSetupRequestService {
  private readonly resolving = new Set<string>();
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }

  private chief(botId: string): BotRecord {
    const chief = this.options.store.bot(botId);
    if (!chief || chief.hidden || !chief.chiefOfStaff) throw new TeamSetupError("Only an active Chief of Staff can propose team setup", 403);
    return chief;
  }

  private fields(input: z.infer<typeof fieldsSchema>, current?: BotRecord): TeamSetupFields {
    const { section: targetSection, modelSelection, ...profile } = input;
    const safe = Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, redactSecretsInText(value!)]));
    const parsed = parseBotProfilePatch(safe, true);
    if (!parsed.ok) throw new TeamSetupError(parsed.error);
    const result: TeamSetupFields = { ...parsed.patch };
    if (targetSection !== undefined) result.section = targetSection;
    if (modelSelection) {
      const selection = modelSelection as ModelSelection;
      const error = this.options.validateModel(selection, current);
      if (error) throw new TeamSetupError(error);
      result.modelSelection = selection;
    }
    return result;
  }

  private validate(request: TeamSetupRequest, confirming: boolean): void {
    const chief = this.chief(request.botId);
    if (!this.options.ownsThread(request.botId, request.threadId)) throw new TeamSetupError("The requesting conversation no longer exists", 409);
    if (confirming && !this.options.store.messagesFor(request.threadId).some((message) => message.card?.requestId === request.requestId && !message.card.answered && !message.card.dismissed)) throw new TeamSetupError("This setup card is no longer pending", 409);
    if (confirming && teamSetupRevision(chief) !== request.requesterRevision) throw new TeamSetupError("The Chief's settings changed. This setup was cancelled; review a new proposal.", 409);
    const existingTeams = new Set(this.options.teams().map(section));
    if (new Set([...(chief.managedSections ?? []), ...request.newTeams]).size > 100) throw new TeamSetupError("A Chief may coordinate at most 100 additional teams", 409);
    for (const name of request.newTeams) if (existingTeams.has(name)) throw new TeamSetupError(`Team ${JSON.stringify(name)} now exists. Review a new proposal.`, 409);
    const allowed = (name?: string) => request.newTeams.includes(section(name)) || this.options.canAccessTeam(chief, name);
    const targets = new Set<string>();
    const projected = this.options.store.bots.map((bot) => ({ id: bot.id, name: bot.name, section: section(bot.section), chiefOfStaff: bot.chiefOfStaff, hidden: bot.hidden }));
    for (const operation of request.operations) {
      if (targets.has(operation.botId)) throw new TeamSetupError("A bot appears twice in the prepared setup");
      targets.add(operation.botId);
      const target = this.options.store.bot(operation.botId);
      if (operation.action === "create") {
        if (target) throw new TeamSetupError("A proposed bot already exists. Review a new proposal.", 409);
        if (!operation.fields.name?.trim() || !operation.fields.title?.trim() || !operation.fields.soul?.trim() || !operation.fields.modelSelection) throw new TeamSetupError("Each new bot needs a name, title, soul instructions, and exact model selection");
      } else {
        if (!target || target.hidden || !this.options.canAccessTeam(chief, target.section) || (target.id !== chief.id && Array.isArray(chief.peers) && !chief.peers.includes(target.id))) throw new TeamSetupError("A target bot is outside this Chief's authorized team and peer scope", 403);
        if (teamSetupRevision(target) !== operation.expectedRevision) throw new TeamSetupError(`@${target.name} changed. This setup was cancelled; review a new proposal.`, 409);
        if (this.options.targetBusy(target.id) && (confirming || target.id !== chief.id)) throw new TeamSetupError(`Stop @${target.name}'s work before changing its setup`, 409);
      }
      const fields = this.fields(operation.fields, target ?? undefined);
      const destination = fields.section ?? target?.section ?? chief.section;
      if (!allowed(destination)) throw new TeamSetupError("The destination team is outside this Chief's authorized scope", 403);
      if (!request.newTeams.includes(section(destination)) && !existingTeams.has(section(destination))) throw new TeamSetupError("The destination team no longer exists", 409);
      const next = { id: operation.botId, name: fields.name ?? target!.name, section: section(destination), chiefOfStaff: target?.chiefOfStaff, hidden: false };
      const at = projected.findIndex((bot) => bot.id === operation.botId);
      if (at < 0) projected.push(next); else projected[at] = next;
    }
    if (this.options.store.bots.length + request.operations.filter((op) => op.action === "create").length > this.options.maxBots) throw new TeamSetupError("This setup exceeds the workspace bot limit", 409);
    for (const name of request.newTeams) if (!request.operations.some((op) => section(op.fields.section) === name)) throw new TeamSetupError(`New team ${JSON.stringify(name)} needs a specialist in this setup`);
    for (const operation of request.operations) {
      const candidate = projected.find((bot) => bot.id === operation.botId)!;
      if (projected.some((bot) => bot.id !== candidate.id && !bot.hidden && bot.section === candidate.section && bot.name.trim().toLowerCase() === candidate.name.trim().toLowerCase())) throw new TeamSetupError(`@${candidate.name} already exists in that team`, 409);
      if (candidate.chiefOfStaff && projected.some((bot) => bot.id !== candidate.id && bot.chiefOfStaff && bot.section === candidate.section)) throw new TeamSetupError("That move would put two Chiefs in one team", 409);
    }
    if (request.deletion) {
      const target = this.options.store.bot(request.deletion.botId);
      if (!target || target.hidden || target.id === chief.id || !this.options.canAccessTeam(chief, target.section) || (Array.isArray(chief.peers) && !chief.peers.includes(target.id))) throw new TeamSetupError("This deletion target is no longer an authorized teammate", 403);
      if (teamSetupRevision(target) !== request.deletion.expectedRevision || this.options.targetBusy(target.id)) throw new TeamSetupError("The deletion target changed or is working. Review a new deletion proposal.", 409);
    }
  }

  propose(args: { botId: string; threadId: string; plan: unknown; from?: { botId: string; name: string; color: string } }) {
    const parsed = planSchema.safeParse(args.plan);
    if (!parsed.success) throw new TeamSetupError(parsed.error.issues[0]?.message ?? "Invalid team setup");
    const chief = this.chief(args.botId);
    const combined = new Map<string, typeof parsed.data.operations[number]>();
    for (const operation of parsed.data.operations) {
      const key = operation.action === "create" ? `create:${operation.key}` : `update:${operation.botId}`;
      const previous = combined.get(key);
      combined.set(key, { ...operation, fields: { ...previous?.fields, ...operation.fields } });
    }
    if (combined.size > 8) throw new TeamSetupError("Review at most eight bots in one setup");
    const operations: TeamSetupOperation[] = [...combined.values()].map((operation) => {
      const target = operation.action === "update" ? this.options.store.bot(operation.botId) : undefined;
      return { action: operation.action, botId: operation.action === "create" ? newId() : operation.botId,
        ...(operation.action === "create" ? { threadId: newId() } : {}),
        fields: this.fields({ ...operation.fields, section: operation.fields.section ?? target?.section ?? chief.section ?? "" }, target ?? undefined),
        ...(target ? { expectedRevision: teamSetupRevision(target) } : {}),
      };
    });
    const request: TeamSetupRequest = { version: 1, requestId: newId(), botId: args.botId, threadId: args.threadId,
      reason: redactSecretsInText(parsed.data.reason), createdAt: Date.now(), requesterRevision: teamSetupRevision(chief),
      newTeams: [...new Set(parsed.data.newTeams)], operations };
    this.validate(request, false);
    return this.card(request, args.from);
  }

  proposeDeletion(args: { botId: string; threadId: string; targetBotId: string; reason: string; from?: { botId: string; name: string; color: string } }) {
    const chief = this.chief(args.botId);
    const target = this.options.store.bot(args.targetBotId);
    if (!target) throw new TeamSetupError("That bot no longer exists", 404);
    if (!args.reason.trim() || args.reason.length > 500) throw new TeamSetupError("A deletion reason of at most 500 characters is required");
    const request: TeamSetupRequest = { version: 1, requestId: newId(), botId: args.botId, threadId: args.threadId,
      reason: redactSecretsInText(args.reason), createdAt: Date.now(), requesterRevision: teamSetupRevision(chief), newTeams: [], operations: [],
      deletion: { botId: target.id, name: target.name, expectedRevision: teamSetupRevision(target) } };
    this.validate(request, false);
    return this.card(request, args.from);
  }

  private card(request: TeamSetupRequest, from?: { botId: string; name: string; color: string }) {
    const permission = this.options.canPersist(request.botId, request.threadId);
    if (!permission.ok) throw new TeamSetupError(permission.error, permission.status);
    const chief = this.chief(request.botId);
    const lines = [`Why: ${request.reason}`];
    if (request.deletion) lines.push(`Delete @${request.deletion.name} (${request.deletion.botId}).`, "Permanently removes this bot, all its conversations, memory, instructions, and skills. Generated project files remain. Active work or owned computers can block deletion.");
    if (request.newTeams.length) lines.push(`Create teams: ${request.newTeams.map((name) => JSON.stringify(name)).join(", ")}.`, `Authorize @${chief.name} to coordinate and propose setup changes in these new teams.`);
    for (const operation of request.operations) {
      const current = this.options.store.bot(operation.botId);
      lines.push(`\n${operation.action === "create" ? "Create" : "Update"} @${operation.fields.name ?? current?.name} (${operation.action === "create" ? "new bot" : operation.botId})`);
      for (const [key, value] of Object.entries(operation.fields)) {
        const before = current ? (key === "section" ? current.section || "General" : current[key as keyof BotRecord]) : undefined;
        lines.push(`${key === "modelSelection" ? "Default engine/model" : key}: ${current ? `${JSON.stringify(before ?? "")} → ` : ""}${key === "section" ? JSON.stringify(value || "General") : JSON.stringify(value)}`);
      }
    }
    if (!request.deletion) lines.push("\nDefault models apply to groups and new threads. Every existing thread keeps its current model and permissions.", "New bots start in Ask with connected apps disabled. Existing execution permissions are unchanged.");
    lines.push("After this decision the Chief continues once with the result.");
    const title = request.deletion ? `Delete @${request.deletion.name}?` : `Apply setup for ${request.operations.length} ${request.operations.length === 1 ? "bot" : "bots"}?`;
    const detail = lines.join("\n");
    const message = this.options.store.appendMessage(request.threadId, { role: "bot", kind: "options", ...(from ? { from } : {}), card: {
      title, subtitle: detail, options: [request.deletion ? "Delete bot" : "Apply setup", "Cancel"], requestId: request.requestId,
      tool: request.deletion ? "delete_bot" : "set_up_team", teamSetupRequest: request,
    } });
    return { requestId: request.requestId, messageId: message.id, title, summary: title, detail };
  }

  async resolve(args: { botId: string; threadId: string; requestId: string; behavior: string }) {
    const message = this.options.store.messagesFor(args.threadId).find((item) => item.card?.requestId === args.requestId && item.card.teamSetupRequest);
    const card = message?.card, request = card?.teamSetupRequest;
    if (!message || !card || !request) return null;
    if (request.botId !== args.botId || request.threadId !== args.threadId || request.requestId !== args.requestId) throw new TeamSetupError("This setup belongs to another conversation", 403);
    if (args.behavior !== "allow" && args.behavior !== "deny") throw new TeamSetupError("Confirm or cancel this setup", 400);
    // Stop/dismiss can close a card without a setup decision. It must never
    // resurrect that review or wake the stopped conversation.
    if (card.answered || card.dismissed) {
      const result = request.result ?? { state: "cancelled" as const, bots: [], newTeams: [], error: "This setup card was closed" };
      return { result, request: { ...request, result }, messageId: message.id, duplicate: true };
    }
    if (this.resolving.has(request.requestId)) throw new TeamSetupError("This setup is already being applied", 409);
    this.resolving.add(request.requestId);
    try {
      const receipt = this.options.store.bot(request.botId)?.lastTeamSetupReceipt;
      let result: TeamSetupResult;
      if (receipt?.requestId === request.requestId) result = receipt.result;
      else if (args.behavior === "deny") result = { state: "denied", bots: [], newTeams: [] };
      else {
        try {
          this.validate(request, true);
          if (request.deletion) {
            await this.options.deleteBot(request.deletion.botId, () => this.validate(request, true), request);
            result = { state: "applied", bots: [{ id: request.deletion.botId, name: request.deletion.name, action: "deleted" }], newTeams: [] };
          } else result = this.options.store.applyTeamSetup(request);
        } catch (error) {
          const saved = this.options.store.bot(request.botId)?.lastTeamSetupReceipt;
          const detail = redactSecretsInText(error instanceof Error ? error.message : String(error));
          result = saved?.requestId === request.requestId
            ? { ...saved.result, error: `The changes were saved, but cleanup needs attention: ${detail}` }
            : { state: error instanceof TeamSetupError ? "cancelled" : "failed", bots: [], newTeams: [], error: detail };
        }
      }
      this.options.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: result.state === "applied" ? "allow" : "deny", held: result.error, teamSetupRequest: { ...request, result } } });
      return { result, request: { ...request, result }, messageId: message.id, duplicate: false };
    } finally { this.resolving.delete(request.requestId); }
  }
}
