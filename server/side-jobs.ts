// Privacy invariants: the helper model is unset by default, never replaces an engine that can write the job itself, and
// never writes for a bot whose own engine is disallowed or whose helperModel switch is anything but absent or true.
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { helperModelAllowed } from "../shared/wire.ts";
import type { ProviderAdapter, ProviderInstance, SmallModelFallback, TextGenerationOptions } from "./contracts.ts";
import type { UsageRow, UsageTrigger } from "./usage-ledger.ts";

/** config.json `helper`: a connected instance and optionally one of its models. Stored config only, so a settings
 * request cannot set it; a mistyped entry reads as no helper rather than costing the whole config. */
export const helperStoredShape = {
  helper: z.object({
    instanceId: z.string().trim().max(200).optional(),
    model: z.string().trim().max(500).optional(),
  }).optional().catch(undefined),
};
export interface HelperConfig {
  helper?: { instanceId?: string; model?: string };
}

/** Goes into a CLI's argv: never a leading dash, no space or control character. */
const HELPER_MODEL_ID = /^[A-Za-z0-9][\x21-\x7e]*$/;

/** OMB_HELPER_INSTANCE / OMB_HELPER_MODEL win over the file; an empty OMB_HELPER_INSTANCE switches a saved helper off.
 * An invalid model switches the helper off rather than writing with a model the person did not name. */
export function helperSelection(cfg: HelperConfig, env: Record<string, string | undefined> = process.env): { instanceId: string; model?: string } | null {
  const instanceId = (env.OMB_HELPER_INSTANCE ?? cfg.helper?.instanceId)?.trim();
  if (!instanceId) return null;
  const model = (env.OMB_HELPER_MODEL ?? cfg.helper?.model)?.trim();
  if (!model) return { instanceId };
  return HELPER_MODEL_ID.test(model) ? { instanceId, model } : null;
}

export type SideJob = "compaction" | "memory" | "skill-review";

export type SideJobInstance = Pick<ProviderInstance, "instanceId" | "driverKind" | "enabled" | "generateText" | "generateMemoryText"> & {
  adapter: { capabilities: Pick<ProviderAdapter["capabilities"], "agentsMcp"> };
};

export interface SideJobBot {
  id: string;
  name: string;
  /** Where a spend alert a call raises is shown. */
  threadId: string;
  modelSelection: { instanceId: string; model?: string };
  helperModel?: boolean;
}

export interface SideJobText {
  via: "engine" | "helper";
  generateText: (prompt: string, options?: Pick<TextGenerationOptions, "signal" | "timeoutMs">) => Promise<string>;
}

export interface SideJobsDeps {
  bot: (botId: string) => SideJobBot | null | undefined;
  instance: (instanceId: string) => SideJobInstance | null | undefined;
  refusal: (instance: SideJobInstance) => string | undefined;
  helper: () => { instanceId: string; model?: string } | null;
  /** Small models each engine instance refused, kept across restarts. */
  smallModels: { refused(instanceId: string): ReadonlySet<string>; remember(instanceId: string, model: string): void };
  /** Hosted workspaces only. */
  modelAllowed?: (selection: { instanceId: string; model: string }) => boolean;
  assertWithinBudget: () => void;
  book: (row: Omit<UsageRow, "at" | "costSource">, tokensReported: boolean, notificationThreadId: string) => void;
  log?: (line: string) => void;
}

export interface SideJobs {
  /** Null when nobody can write it and the job keeps its fallback. `at.instance`: the conversation's engine, for the summary. */
  text(job: SideJob, botId: string, at?: { instance?: SideJobInstance }): SideJobText | null;
}

type TextCall = (prompt: string, options?: TextGenerationOptions) => Promise<string>;

function ownCall(job: SideJob, instance: SideJobInstance): TextCall | undefined {
  // generateMemoryText starts a whole agent process: background jobs only, never the summary a turn waits on.
  const call = job === "compaction" ? instance.generateText : instance.generateText ?? instance.generateMemoryText;
  return call?.bind(instance);
}

export function createSideJobs(deps: SideJobsDeps): SideJobs {
  // Logged once per change, not once per call.
  let said: string | null = null;
  const say = (line: string | null) => {
    if (line && line !== said) deps.log?.(`helper model: ${line}`);
    said = line;
  };

  const ownFallback = (bot: SideJobBot, instance: SideJobInstance): SmallModelFallback => ({
    ...(bot.modelSelection.instanceId === instance.instanceId && bot.modelSelection.model ? { model: bot.modelSelection.model } : {}),
    refused: deps.smallModels.refused(instance.instanceId),
    onRefused: (model) => {
      deps.log?.(`small model ${model} refused on ${instance.instanceId}: background text runs on the bot's own model`);
      deps.smallModels.remember(instance.instanceId, model);
    },
  });

  /** Every call checks the spend limit: one upkeep pass makes several in a row. */
  const booked = (job: SideJob, bot: SideJobBot, instance: SideJobInstance, call: TextCall, trigger: UsageTrigger, fixed: () => TextGenerationOptions): SideJobText["generateText"] =>
    async (prompt, options) => {
      deps.assertWithinBudget();
      const threadId = `${job}-${randomUUID()}`;
      return call(prompt, {
        ...options,
        ...fixed(),
        onUsage: (usage) => deps.book({
          botId: bot.id,
          botName: bot.name,
          threadId,
          instanceId: instance.instanceId,
          driverKind: instance.driverKind,
          model: usage.model,
          input: usage.input ?? 0,
          output: usage.output ?? 0,
          ...(usage.cachedInput !== undefined ? { cachedInput: usage.cachedInput } : {}),
          costUsd: usage.costUsd ?? null,
          trigger,
        }, usage.input !== undefined && usage.output !== undefined, bot.threadId),
      });
    };

  /** Whatever the lookup throws reads as no helper: a helper never fails a job or the turn waiting on one. */
  function usableHelper(): { instance: SideJobInstance; call: TextCall; model?: string } | null {
    try {
      return findHelper();
    } catch (error) {
      // A JSON error can quote the text it failed on.
      const why = error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : "unknown";
      say(`the helper could not be looked up (${why}), so bots whose engine has no one-off text call keep their fallback`);
      return null;
    }
  }

  function findHelper(): { instance: SideJobInstance; call: TextCall; model?: string } | null {
    const helper = deps.helper();
    if (!helper) {
      say(null);
      return null;
    }
    const name = JSON.stringify(helper.instanceId);
    const unused = (why: string) => {
      say(`${why}, so bots whose engine has no one-off text call keep their fallback`);
      return null;
    };
    const instance = deps.instance(helper.instanceId);
    if (!instance) return unused(`the helper instance ${name} is not connected`);
    if (!instance.enabled) return unused(`the helper instance ${name} is switched off`);
    if (!instance.generateText) return unused(`the helper instance ${name} cannot make a one-off text call`);
    const refusal = deps.refusal(instance);
    if (refusal) return unused(`the helper instance ${name} is not used (${refusal})`);
    if (helper.model && deps.modelAllowed && !deps.modelAllowed({ instanceId: helper.instanceId, model: helper.model })) {
      return unused(`the helper model ${JSON.stringify(helper.model)} is not assigned to this workspace`);
    }
    say(`small writing jobs for bots whose engine has no one-off text call are written by ${name}${helper.model ? ` (${helper.model})` : ""}`);
    return { instance, call: instance.generateText.bind(instance), ...(helper.model ? { model: helper.model } : {}) };
  }

  return {
    text(job, botId, at = {}) {
      const bot = deps.bot(botId);
      const own = at.instance ?? (bot ? deps.instance(bot.modelSelection.instanceId) : null);
      if (!bot || !own || deps.refusal(own)) return null;
      // The review's changes are written with the bot's own skill tools, whoever read the conversation.
      if (job === "skill-review" && own.adapter.capabilities.agentsMcp !== true) return null;
      const call = ownCall(job, own);
      if (call) {
        // The summary belongs to a turn that already passed the spend limit and is not booked on its own.
        if (job === "compaction") return { via: "engine", generateText: call };
        return { via: "engine", generateText: booked(job, bot, own, call, { kind: "bot", botId: bot.id }, () => ({ fallback: ownFallback(bot, own) })) };
      }
      if (!helperModelAllowed(bot)) return null;
      const helper = usableHelper();
      if (!helper) return null;
      return { via: "helper", generateText: booked(job, bot, helper.instance, helper.call, { kind: "helper", botId: bot.id, job }, () => (helper.model ? { model: helper.model } : {})) };
    },
  };
}
