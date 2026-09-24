import { api, persistBotUpdate, type Bot } from "@/state/store";
import type { Routine } from "./routines";
import type { BotCreationDraft } from "./bot-creation-draft";
import { imageAttachmentFromFile } from "./composer-attachments";
import type { BotVisibility } from "../../shared/wire";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar";

export async function preparedBotTemplate(draft: BotCreationDraft) {
  const template = draft.export();
  if (template.profile.avatarUrl?.startsWith("blob:")) {
    if (!draft.avatarFile) throw new Error("Choose the avatar image again");
    const uploaded = await imageAttachmentFromFile(draft.avatarFile);
    const avatarUrl = uploaded && botAvatarUrlFromStoredPath(uploaded.path);
    if (!avatarUrl) throw new Error("Could not store the avatar image");
    template.profile.avatarUrl = avatarUrl;
  }
  return template;
}

/** Create only after the user commits. File setup and native consent finish
 * before Chief handover or routine activation can affect other work. */
export async function createConfiguredBot(
  draft: BotCreationDraft,
  request: typeof api = api,
  update: typeof persistBotUpdate = persistBotUpdate,
  approvals = typeof window === "undefined" ? undefined : window.ogb?.approvals,
  visibility?: BotVisibility,
): Promise<{ bot: Bot; warnings: string[] }> {
  const template = await preparedBotTemplate(draft);
  const { chiefOfStaff, managedSections, ...profile } = template.profile;
  if (!profile.name?.trim()) throw new Error("Give the bot a name");
  const response = await request<{ bot: Bot }>("/api/bots", {
    method: "POST", body: JSON.stringify({ name: profile.name, title: profile.title,
      description: profile.description, modelSelection: profile.modelSelection, section: profile.section,
      requireAvailableModel: true, useDefaults: false, ...(visibility !== undefined ? { visibility } : {}) }),
  });
  let bot = response.bot;
  const routines: Array<{ id: string; enabled: boolean }> = [];
  const warnings: string[] = [];
  try {
    // The create endpoint already validated the chosen model and completed
    // workspace effort defaults. Do not overwrite those with the raw draft.
    const patched = await update(bot.id, { ...profile, modelSelection: bot.modelSelection, ...draft.consent }, new AbortController().signal,
      request, approvals, bot);
    bot = { ...bot, ...patched };
    if (profile.approvalMode === "full" || profile.approvalMode === "custom") {
      // persistBotUpdate grants the bot default first. An initial thread is
      // already present, so it also needs the native thread-scoped grant.
      if (patched.approvalMode !== profile.approvalMode || !approvals) {
        throw new Error("The bot's requested approval level was not granted");
      }
      const granted = await approvals.setMode(bot.id, profile.approvalMode, {
        threadId: bot.threadId, threadOnly: true,
        acknowledgeLocalAuto: draft.consent.acknowledgeLocalAuto === true,
      });
      if (granted.approvalMode !== profile.approvalMode) {
        throw new Error("The initial thread's requested approval level was not granted");
      }
    }
    for (const [path, text] of Object.entries(template.memory)) {
      await request(`/api/bots/${bot.id}/memory/file`, {
        method: "PUT", body: JSON.stringify({ path, text }),
      });
    }
    for (const skill of template.skills) {
      await request(`/api/bots/${bot.id}/skill-template`, { method: "POST", body: JSON.stringify(skill) });
    }
    for (const routine of template.routines) {
      const result = await request<{ routine: Routine }>("/api/routines", {
        method: "POST", body: JSON.stringify({ ...routine, botId: bot.id, enabled: false }),
      });
      routines.push({ id: result.routine.id, enabled: routine.enabled !== false });
    }
  } catch (error) {
    const cleanup: string[] = [];
    for (const routine of routines) {
      try { await request(`/api/routines/${routine.id}`, { method: "DELETE" }); }
      catch { cleanup.push(`routine ${routine.id}`); }
    }
    try { await request(`/api/bots/${bot.id}`, { method: "DELETE" }); }
    catch { cleanup.push(`bot ${bot.name} (${bot.id})`); }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(cleanup.length ? `${message}. Cleanup failed for ${cleanup.join(", ")}; remove them before retrying.` : message);
  }
  // Creation is complete. Activation failures leave a visible, configured
  // bot with paused routines; never delete a bot whose routine may have run,
  // undo a Chief handover, or invite a duplicate creation retry.
  if (chiefOfStaff) {
    try {
      const result = await request<{ bot: Bot }>(`/api/bots/${bot.id}`, {
        method: "PATCH", body: JSON.stringify({ chiefOfStaff, managedSections, acknowledgePeerScope: true }),
      });
      bot = { ...bot, ...result.bot };
    } catch (error) {
      warnings.push(`Review this bot's Chief of Staff setting: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const routine of routines.filter(routine => routine.enabled)) {
    try { await request(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }); }
    catch (error) { warnings.push(`Could not activate a routine: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { bot, warnings };
}
