// Provider-resolution phase for the direct-turn engine (server/start-turn.ts).
import { llmThreadTitlesEnabled, type AppConfig } from "../../config.ts";
import { assertModelVariantSupported } from "../../member-turn.ts";
import { extractTurnImages } from "../../turn-images.ts";
import { type BotRecord, type Store } from "../../store.ts";
import type { StartTurnOptions } from "../../start-turn.ts";
import type { Deps } from "./shared.ts";

/** Provider resolution: surface plan, provider instance, image/text split and model selection. */
export function resolveTurnProvider({
  botId,
  text,
  opts,
  bot,
  threadId,
  store,
  cfg,
  generateThreadTitle,
  turnSurfacePlan,
  turnProvider,
  turnInstance,
  providerInstancesChanging,
  markInternalTurn,
  clearInternalTurn,
}: {
  botId: string;
  text: string;
  opts: StartTurnOptions | undefined;
  bot: BotRecord;
  threadId: string;
  store: Store;
  cfg: AppConfig;
  generateThreadTitle: Deps["titles"]["generateThreadTitle"];
  turnSurfacePlan: Deps["admission"]["turnSurfacePlan"];
  turnProvider: Deps["admission"]["turnProvider"];
  turnInstance: Deps["admission"]["turnInstance"];
  providerInstancesChanging: Deps["admission"]["providerInstancesChanging"];
  markInternalTurn: Deps["turnMarks"]["markInternalTurn"];
  clearInternalTurn: Deps["turnMarks"]["clearInternalTurn"];
}) {
  const plan = turnSurfacePlan(bot, opts?.runOn, threadId);
  const instance = turnInstance(bot, opts?.runOn, threadId);
  if (!instance) {
    throw Object.assign(
      new Error(
        turnProvider(bot, opts?.runOn, threadId) === "box"
          ? "the Cloud VM runner is unavailable — configure Box in App Settings"
          : `provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`,
      ),
      { status: 409 },
    );
  }
  // Resolve only transport tags from this newly submitted text. The original
  // string remains the durable message. Native-image providers get a
  // path-free prompt and bounded inputs instead of needing a Read tool;
  // path-reading drivers retain the attachment tag as their compatibility route.
  const resolvedImages = extractTurnImages(text);
  const usesNativeImageInput = instance.adapter.capabilities.nativeImageInput === true;
  const providerText = usesNativeImageInput ? resolvedImages.text : text;
  const turnImages = usesNativeImageInput ? resolvedImages.images : [];
  const commsDepth = opts?.commsDepth ?? 0;
  // Classify the turn where the peer paths' depth actually arrives: by the
  // time it settles, the fold has only a thread id to go on.
  if (commsDepth > 0) markInternalTurn(threadId);
  else clearInternalTurn(threadId);
  // a task takes its name from the first thing you asked it to do
  if (resolvedImages.text.trim() && !opts?.cardContinuation) {
    const titled = store.titleTaskFromFirstMessage(bot.id, resolvedImages.text, threadId);
    // The snippet is only the fallback name. A cheap one-shot may trade it
    // for a title a person would have typed, but never on a peer-opened
    // row: adoption recognises those by the exact title their assignment
    // gave them (openingRequestTitle), and a generated one would break the
    // comparison it renames under. Everywhere else, the swap happens only
    // while the row still carries the snippet — a rename by the person or
    // by adoption has already broken that equality by then.
    const snippet = titled?.title;
    if (titled && snippet && !titled.openedBy?.botId && llmThreadTitlesEnabled(cfg) && instance.generateText) {
      void generateThreadTitle(instance, resolvedImages.text)
        .then((title) => {
          if (title) store.retitleTask(bot.id, threadId, snippet, title);
        })
        .catch(() => undefined);
    }
  }

  console.error(`[omb-turn] bot=${botId} text=${JSON.stringify(resolvedImages.text.slice(0, 70))} images=${turnImages.length} depth=${commsDepth} card=${Boolean(opts?.cardContinuation)}`);
  const instanceId = instance.instanceId;
  if (providerInstancesChanging().has(instanceId)) {
    throw Object.assign(new Error("this provider account is being updated — try again shortly"), { status: 409 });
  }
  const switchedEngine = instance.instanceId !== bot.modelSelection.instanceId;
  const model = opts?.runOn === "cloud" || switchedEngine ? instance.models.default : bot.modelSelection.model;
  // a cloud routine borrows the instance default model, so it borrows no
  // per-bot effort either
  const effort = opts?.runOn === "cloud" || switchedEngine ? undefined : bot.modelSelection.effort;
  const variant = opts?.runOn === "cloud" || switchedEngine ? undefined : bot.modelSelection.variant;
  assertModelVariantSupported({ variant, effort }, instance.adapter.capabilities);
  // A selection can be persisted while its engine is offline. Re-check when
  // the engine returns so an old or unsupported value never reaches a CLI.
  if (effort && !instance.adapter.capabilities.effortLevels?.includes(effort)) {
    throw Object.assign(
      new Error(`effort "${effort}" is not offered by this bot's engine — choose another level in settings`),
      { status: 409 },
    );
  }
  return { plan, instance, providerText, turnImages, commsDepth, instanceId, model, effort, variant };
}

