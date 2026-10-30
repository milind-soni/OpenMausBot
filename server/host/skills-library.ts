import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { SkillRequestCardData, SkillShareRecord } from "../../shared/skill-request.ts";
import { narrowestAudience, intersectAudience } from "../bot-visibility.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import { appendDecision } from "../decision-log.ts";
import { UNDO_STALE, type DirectApply } from "../direct-apply.ts";
import {
  expandImportedSkillCommand, importedSkillListings, importedSkillsFor, importedSkillsPrompt, nativeSkillFolders, readImportedSkillFile, readImportedSkills,
  type ImportedSkillView, type SkillTurnEngine,
} from "../imported-skills.ts";
import { nativeSkillListing, nativeSkills, readNativeSkillFile } from "../native-skills.ts";
import { redactSecretsInText } from "../redact.ts";
import { listLibrarySkills, readLibrarySkillFile, readSkillLibraryIndex, skillsLibraryEnabled } from "../skill-library.ts";
import {
  conversationAssignedSkills,
  prepareShareNote,
  shareLearnedSkill,
  shareLearnedSkillsMode,
  SHARED_REVISION_CHARS,
  sharedSkillEditable,
  undoSharedLearnedSkill,
  updateSharedLearnedSkill,
  type ShareBot,
} from "../skill-share.ts";
import { expandSkillCommandTurnText, listSkills, readSkillFile, resolveBotSkills, skillsSystemPrompt, type SkillListing } from "../skills.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { claudeUserSkillsEnabled } from "../turn-settings.ts";
import { TASK_WORKSPACES_DIR } from "../workspace.ts";

type ReceiptArgs = {
  botId: string;
  threadId: string;
  applied?: boolean;
  previous?: SkillRequestCardData["previous"];
  shared?: SkillShareRecord;
  staged: {
    id: string;
    action: "create" | "update";
    name: string;
    gist: string;
    source: string;
    files: Array<{ path: string; content: string }>;
    sha256: string;
    warnings: string[];
  };
};

export interface SkillsLibraryHostDeps {
  store: Store;
  cfg: AppConfig;
  appendSkillRequestCard(args: ReceiptArgs): { requestId: string; summary: string };
  /** An engine instance's saved config and environment: they decide which skill folders it loads by itself. */
  engineConfig?(instanceId: string): { config?: unknown; environment?: Record<string, string> } | undefined;
  /** The engine instance a bot's new turns run on, for listings made outside a turn. */
  instanceOf?(instanceId: string): TurnInstance | undefined;
}

/** The engine instance a turn runs on. */
type TurnInstance = { instanceId: string; driverKind: string };

type UndoResult =
  | { claimed: true; state: "undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true };

/** `after` records the note as delivered only once the provider accepted the dispatch. */
export interface TurnShareNote {
  text: string;
  after<T>(dispatch: Promise<T>): Promise<T>;
}

const NO_TURN_NOTE: TurnShareNote = { text: "", after: (dispatch) => dispatch };

export function createSkillsLibraryHost(deps: SkillsLibraryHostDeps) {
  const { store, cfg } = deps;
  const mode = () => shareLearnedSkillsMode(cfg);

  /** The bot's own skills, and its library skills while the library is on; an imported skill of the same name yields. */
  const ownSkills = (bot: BotRecord) =>
    skillsLibraryEnabled(cfg) ? resolveBotSkills(bot.id, bot.assignedSkills ?? []) : listSkills(bot.id);
  const listBotSkills = (bot: BotRecord, threadId = bot.threadId): SkillListing[] => {
    const own = ownSkills(bot);
    const listed = [...own, ...importedSkillListings(bot.id, new Set(own.map((skill) => skill.name)))];
    const names = new Set(listed.map((skill) => skill.name));
    return [...listed, ...nativesFor(bot, threadId).filter((skill) => !names.has(skill.name)).map(nativeSkillListing)];
  };
  const readBotSkillFile = (bot: BotRecord, name: string): string | null => {
    const own = readSkillFile(bot.id, name);
    if (own !== null) return own;
    // Private wins collisions: a private skill that no longer verifies must not fall through to a same-named shared one.
    if (listSkills(bot.id).some((skill) => skill.name === name)) return null;
    // The library fallback is by assignment only, never by name alone.
    if (skillsLibraryEnabled(cfg) && listLibrarySkills().some((skill) => skill.name === name && (skill.everyBot || bot.assignedSkills?.includes(name)))) return readLibrarySkillFile(name);
    if (readImportedSkills()[name]) return readImportedSkillFile(name);
    const native = nativesFor(bot).find((skill) => skill.name === name);
    return native ? readNativeSkillFile(native) : null;
  };

  const shareBotsNow = (): ShareBot[] =>
    store.bots.map((bot) => ({ id: bot.id, name: bot.name, section: bot.section, assignedSkills: bot.assignedSkills, visibility: bot.visibility }));
  const patchAssigned = (botId: string, assignedSkills: string[]) => {
    store.patchBot(botId, { assignedSkills });
  };
  /** The bot's audience, narrowed to the room's (its bots and its floor) when the conversation is a room. */
  const sourceAudience = (bot: { visibility?: unknown }, threadId?: string): unknown => {
    const room = threadId ? store.groupByThread(threadId) : undefined;
    if (!room) return bot.visibility;
    const members = room.memberIds.flatMap((id) => {
      const member = store.bot(id);
      return member ? [member.visibility] : [];
    });
    return intersectAudience(bot.visibility, narrowestAudience([room.audienceFloor, ...members]));
  };
  const conversationStartedAt = (threadId: string): number | undefined => store.messagesFor(threadId)[0]?.at;
  // The bot record predates awaited setup work; an assignment PUT in that window must still reach this prompt.
  // An empty list, not undefined, while the library is on: every-bot skills still reach a bot with no assignments.
  const liveAssigned = (bot: BotRecord) => store.bot(bot.id)?.assignedSkills ?? bot.assignedSkills ?? [];
  const conversationSkills = (bot: BotRecord, threadId: string): string[] | undefined =>
    skillsLibraryEnabled(cfg) ? conversationAssignedSkills(bot.id, liveAssigned(bot), conversationStartedAt(threadId)) : undefined;

  const engineOf = (instance: TurnInstance | undefined): SkillTurnEngine | undefined => {
    if (!instance) return undefined;
    const saved = deps.engineConfig?.(instance.instanceId);
    return {
      driverKind: instance.driverKind,
      ...(saved?.config !== undefined ? { config: saved.config } : {}),
      ...(saved?.environment ? { environment: saved.environment } : {}),
    };
  };
  /** This computer's skills for one turn: after the bot's own and library skills (`assigned`), less what the turn's
   * engine already loads from the same folder. */
  const importsFor = (bot: BotRecord, assigned: readonly string[] | undefined, instance: TurnInstance | undefined): ImportedSkillView[] =>
    importedSkillsFor(bot.id, new Set(resolveBotSkills(bot.id, assigned).map((skill) => skill.name)),
      nativeSkillFolders(engineOf(instance), { claudeUserSkills: claudeUserSkillsEnabled(cfg) }));

  /** The folder a thread's turns run in, as the store pins it on its first turn; null for a thread pinned to none. */
  const threadFolder = (bot: BotRecord, threadId: string): string | null => {
    const task = store.taskByThread(bot.id, threadId);
    return task?.cwd !== undefined ? task.cwd : bot.cwd ?? join(TASK_WORKSPACES_DIR, bot.id, threadId);
  };
  /** Outside a turn, what the bot's main conversation would load. */
  const nativesFor = (bot: BotRecord, threadId = bot.threadId, instance = deps.instanceOf?.(bot.modelSelection.instanceId)) => {
    const engine = engineOf(instance);
    return engine ? nativeSkills(engine, { claudeUserSkills: claudeUserSkillsEnabled(cfg), cwd: threadFolder(bot, threadId) }) : [];
  };

  const editable = (botId: string, name: string): boolean =>
    mode() !== "off" && sharedSkillEditable(botId, store.bot(botId)?.assignedSkills, name);

  function summaryLine(share: SkillShareRecord): string {
    const mates = share.assigned.map((bot) => bot.name);
    const skipped = share.skipped.map((bot) => `${bot.name} (${bot.reason})`);
    return [
      mates.length ? `Shared with ${mates.join(", ")}.` : "No teammate needed it assigned.",
      skipped.length ? `Not shared with ${skipped.join(", ")}.` : "",
    ].filter(Boolean).join(" ");
  }

  function shareFromBot(
    botId: string,
    name: string,
    receipt?: { threadId: string; messageId: string; expectSha256?: string },
  ): SkillShareRecord | { error: string; stale?: true } {
    const bots = shareBotsNow();
    const author = bots.find((bot) => bot.id === botId);
    if (!author) return { error: "unknown bot" };
    const shared = shareLearnedSkill({
      author, bots, name, patchAssigned,
      audience: sourceAudience(author, receipt?.threadId),
      ...(receipt?.expectSha256 ? { expectSha256: receipt.expectSha256 } : {}),
    });
    if (receipt && !("stale" in shared)) {
      const message = store.messagesFor(receipt.threadId).find((candidate) => candidate.id === receipt.messageId);
      const card = message?.card;
      const request = card?.skillRequest;
      if (card && request) {
        const { shareError: _shareError, ...rest } = request;
        store.patchMessage(receipt.threadId, receipt.messageId, {
          card: { ...card, skillRequest: "error" in shared ? { ...request, shareError: shared.error } : { ...rest, shared } },
        });
      }
    }
    return shared;
  }

  function applySharedUpdate(
    from: BotRecord,
    threadId: string,
    change: { name: string; skillMd: string; gist?: string; expectSha256: string | undefined },
    direct: DirectApply,
  ): { name: string; summary: string; shared: string } | { error: string } {
    const bots = shareBotsNow();
    const self = bots.find((bot) => bot.id === from.id);
    if (!self) return { error: "unknown bot" };
    if (!change.expectSha256) {
      return { error: `skill "${change.name}" is shared with your team: call skills_list, read the skill, and pass the revision it lists as base_revision` };
    }
    const updated = updateSharedLearnedSkill({
      bot: self,
      bots,
      name: change.name,
      skillMd: change.skillMd,
      expectSha256: change.expectSha256,
      patchAssigned,
      assignOnward: mode() === "auto",
      audience: sourceAudience(self, threadId),
    });
    if ("error" in updated) return updated;
    const gist = redactSecretsInText(change.gist ?? "").replace(/\s+/g, " ").trim().slice(0, 240) || updated.description.slice(0, 240);
    const receipt = deps.appendSkillRequestCard({
      botId: from.id,
      threadId,
      applied: true,
      previous: { preview: updated.previous.skillMd, source: updated.previous.source },
      shared: updated.share,
      staged: {
        id: randomUUID(),
        action: "update",
        name: change.name,
        gist,
        source: updated.previous.source,
        files: [{ path: "SKILL.md", content: updated.content }],
        sha256: updated.sha256,
        warnings: updated.warnings,
      },
    });
    appendDecision(DATA_DIR, { threadId, requestId: receipt.requestId, botId: from.id, botName: from.name,
      tool: "stage_skill", summary: receipt.summary, decision: "auto-approved", source: direct });
    return { name: change.name, summary: `Shared skill ${change.name} updated.`, shared: summaryLine(updated.share) };
  }

  return {
    listBotSkills,
    readBotSkillFile,

    mode,

    conversationStartedAt,

    conversationSkills,

    /** A turn's skills index, or the preview's without a thread: the bot's own and library skills, then the ones from
     * this computer, each with a budget of its own. */
    skillsIndex(bot: BotRecord, threadId: string | undefined, instance?: TurnInstance): string {
      const assigned = threadId === undefined ? (skillsLibraryEnabled(cfg) ? bot.assignedSkills ?? [] : undefined) : conversationSkills(bot, threadId);
      return skillsSystemPrompt(bot.id, assigned, threadId === undefined ? undefined : conversationStartedAt(threadId)) +
        importedSkillsPrompt(importsFor(bot, assigned, instance));
    },

    /** The imported skills a turn links into its task folder: the same ones its index lists. */
    turnImports(bot: BotRecord, threadId: string, instance?: TurnInstance): ImportedSkillView[] {
      return importsFor(bot, conversationSkills(bot, threadId), instance);
    },

    /** `/name` for one of the bot's own, library or imported skills, or one its engine loads by itself. */
    expandSkillCommand(bot: BotRecord, threadId: string, text: string, instance?: TurnInstance): string {
      const assigned = skillsLibraryEnabled(cfg) ? liveAssigned(bot) : undefined;
      const own = expandSkillCommandTurnText(bot.id, text, assigned);
      if (own !== text || !text.trimStart().startsWith("/")) return own;
      const imported = expandImportedSkillCommand(text, importsFor(bot, assigned, instance));
      if (imported !== text) return imported;
      // A skill switched off on the Skills page stays off, even when the engine holds one of the same name.
      const switched = new Set([...resolveBotSkills(bot.id, assigned), ...importedSkillListings(bot.id, new Set())]
        .filter((skill) => !skill.enabled).map((skill) => skill.name));
      return expandImportedSkillCommand(text, nativesFor(bot, threadId, instance).filter((skill) => !switched.has(skill.name)));
    },

    shareNote(bot: BotRecord, threadId: string, enabled: boolean): TurnShareNote {
      if (!enabled || !skillsLibraryEnabled(cfg)) return NO_TURN_NOTE;
      try {
        const note = prepareShareNote(bot.id, threadId, liveAssigned(bot), conversationStartedAt(threadId), listSkills(bot.id).map((skill) => skill.name));
        if (!note.text) return NO_TURN_NOTE;
        return { text: note.text, after: (dispatch) => dispatch.then((value) => { commitNote(note.commit); return value; }) };
      } catch (error) {
        console.warn(`[skills-library] could not prepare the shared-skill note: ${errorText(error)}`);
        return NO_TURN_NOTE;
      }
    },

    reviewSkills<T extends { name: string }>(botId: string, own: T[]): Array<T | {
      name: string; description: string; editable: boolean; enabled: boolean; sha256: string; body?: string | null;
    }> {
      const bot = store.bot(botId);
      if (mode() === "off" || !bot?.assignedSkills?.length) return own;
      const ownNames = new Set(own.map((skill) => skill.name));
      const shared = resolveBotSkills(botId, bot.assignedSkills)
        .filter((skill) => !ownNames.has(skill.name))
        .map((skill) => {
          const canEdit = editable(botId, skill.name);
          return { name: skill.name, description: skill.description, editable: canEdit, enabled: skill.enabled, sha256: skill.sha256,
            ...(canEdit ? { body: readLibrarySkillFile(skill.name) } : {}) };
        });
      return [...own, ...shared];
    },

    sharedSha: (botId: string, name: string): string | null =>
      editable(botId, name) ? readSkillLibraryIndex()[name]?.sha256 ?? null : null,

    editable,

    applyReviewUpdate(bot: BotRecord, threadId: string, change: { name: string; skillMd: string; gist: string; baseSha256?: string }, direct: DirectApply):
      { ok: true } | { ok: false; error: string } {
      const updated = applySharedUpdate(bot, threadId, {
        name: change.name, skillMd: change.skillMd, gist: change.gist || undefined, expectSha256: change.baseSha256,
      }, direct);
      return "error" in updated ? { ok: false, error: updated.error } : { ok: true };
    },

    harnessUpdate(from: BotRecord, threadId: string, name: string, skillMd: string, gist: unknown, baseRevision: unknown, direct: DirectApply | null):
      [status: number, body: Record<string, unknown>] {
      if (!direct) return [422, { state: "failed", error: "this conversation cannot update a shared team skill" }];
      const updated = applySharedUpdate(from, threadId, {
        name, skillMd, gist: typeof gist === "string" ? gist : undefined, expectSha256: typeof baseRevision === "string" ? baseRevision : undefined,
      }, direct);
      if ("error" in updated) return [422, { state: "failed", error: updated.error }];
      return [201, { state: "applied", name: updated.name, action: "update", summary: updated.summary, shared: updated.shared }];
    },

    harnessListing(botId: string, skills: SkillListing[]): Array<SkillListing & { revision?: string }> {
      if (mode() === "off") return skills;
      return skills.map((skill) => !skill.editable && editable(botId, skill.name)
        ? { ...skill, editable: true, revision: skill.sha256.slice(0, SHARED_REVISION_CHARS) }
        : skill);
    },

    /** A settlement still pending keeps its stage bound to the private copy, so it waits for the receipt's Share button. */
    afterOwnApply<T extends { settlementPending?: boolean }>(botId: string, threadId: string, staged: { id: string; name: string }, applied: T):
      T & { shared?: string; shareError?: string } {
      if (mode() !== "auto" || applied.settlementPending) return applied;
      const receipt = store.messagesFor(threadId).findLast((message) => message.card?.skillRequest?.stagedId === staged.id);
      const shared = shareFromBot(botId, staged.name, receipt ? { threadId, messageId: receipt.id } : undefined);
      return "error" in shared ? { ...applied, shareError: shared.error } : { ...applied, shared: summaryLine(shared) };
    },

    shareFromReceipt(threadId: string, requestId: string):
      | { ok: true; shared: SkillShareRecord }
      | { ok: false; status: number; error: string } {
      if (mode() === "off") return { ok: false, status: 404, error: "sharing learned skills is not enabled" };
      const message = store.messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId);
      const card = message?.card;
      const request = card?.skillRequest;
      if (!message || !card || !request) return { ok: false, status: 404, error: "this skill is no longer in the conversation" };
      if (!card.autoApplied || card.answered !== "allow" || card.undone) {
        return { ok: false, status: 409, error: "only a skill change that applied and was not undone can be shared" };
      }
      if (request.shared) return { ok: true, shared: request.shared };
      const botId = message.from?.botId ?? store.botByThread(threadId)?.id;
      if (!botId || botId !== request.botId) return { ok: false, status: 403, error: "this skill belongs to a different bot" };
      const shared = shareFromBot(botId, request.name, { threadId, messageId: message.id, expectSha256: request.sha256 });
      if ("stale" in shared) return { ok: false, status: 409, error: shared.error };
      return "error" in shared ? { ok: false, status: 422, error: shared.error } : { ok: true, shared };
    },

    shareFromBot,

    undoReceipt(botId: string, threadId: string, message: Message, request: SkillRequestCardData & { shared: SkillShareRecord }): UndoResult {
      const undone = undoSharedLearnedSkill({
        authorId: botId,
        name: request.name,
        action: request.action,
        share: request.shared,
        ...(request.previous ? { previous: { skillMd: request.previous.preview, source: request.previous.source } } : {}),
        bots: shareBotsNow(),
        patchAssigned,
      });
      if ("stale" in undone) return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
      if ("error" in undone) return { claimed: true, state: "invalid", error: undone.error, status: 409 };
      if (message.card) store.patchMessage(threadId, message.id, { card: { ...message.card, undone: true } });
      return { claimed: true, state: "undone" };
    },
  };
}

export type SkillsLibraryHost = ReturnType<typeof createSkillsLibraryHost>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commitNote(commit: () => void): void {
  try {
    commit();
  } catch (error) {
    console.warn(`[skills-library] could not record the shared-skill note: ${errorText(error)}`);
  }
}
