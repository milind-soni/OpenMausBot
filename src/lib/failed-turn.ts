// A failed turn is stored as an activity row named "error: <the engine's
// words>" (shared/failed-turn.ts, written the same for a 1:1 chat and a
// room). This is the one place that decides what a person reads for it: the
// chat row's headline (ChatView's FailedTurnRow, which rooms render too) and
// the sidebar preview both ask signedOutEngine, so they never disagree.
import { offersSignIn } from "@/components/EngineSetup";
import { t } from "@/lib/i18n";
import { plainErrorLine } from "@/lib/plain-error";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import { failedTurnCause } from "../../shared/failed-turn";
import { isClientCancellation, isStoppedTurnName } from "../../shared/client-cancel";

export { failedTurnCause };

type ActivityTool = NonNullable<Message["tool"]>;

/** Whether this engine is waiting on a sign-in: its setup card is the
 * sign-in. The one answer a failed turn's row (signedOutEngine) and a place's
 * "Sign in first" (src/lib/place-view.ts) both read. */
export function engineSignedOut(engine: InstanceInfo | undefined): boolean {
  return Boolean(engine?.snapshot) && offersSignIn(engine);
}

/** The engine a failed turn is waiting on a sign-in for, if any. A
 * signed-out engine's own words are an instruction for a terminal ("Please
 * run /login") nobody here can follow, so while it still reads signed out
 * and its card is the sign-in, the row says that in plain words instead. A
 * Claude update offer is not a sign-in: it replaces the setup card. Anything
 * else keeps the engine's words: they are the most precise cause there is. */
export function signedOutEngine(tool: ActivityTool, engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return tool.setup && !tool.claudeUpdate && engineSignedOut(engine) ? engine : undefined;
}

/** The engine a bot's turns run on — what its failed-turn row is about. */
export function botEngine(bot: Bot | undefined, instances: InstanceInfo[]): InstanceInfo | undefined {
  return bot && instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
}

/** One line for a list preview: a Data receipt its result's title, a
 * failed turn what its row says, minus the "below" a list has no room for;
 * any other activity row its name. */
export function activityPreview(tool: ActivityTool, engine: InstanceInfo | undefined, dataResult?: Message["dataResult"]): string {
  if (dataResult) return dataResult.title;
  if (isStoppedTurnName(tool.name)) return t("chat.turnStopped");
  const cause = failedTurnCause(tool.name);
  if (cause !== null && isClientCancellation(cause)) return t("chat.turnStopped");
  if (cause === null) return tool.name;
  const signedOut = signedOutEngine(tool, engine);
  return signedOut ? t("sidebar.preview.signedOut", { name: signedOut.displayName }) : plainErrorLine(cause) ?? cause;
}
