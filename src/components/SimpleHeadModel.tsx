import { reportsUsage, usageTone, useEngineLimits } from "@/lib/limit-resets";
import { withTypedModels } from "@/lib/model-choices";
import type { Bot } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";
import { modelAttention } from "./model-attention";
import { ModelPicker } from "./ModelPicker";

/** Simple mode's header names the model only when something about it needs the person: the AI needs setting up or
 * signing in to, is gone from this computer, the organization blocks the model, or its usage is near or at the limit.
 * While all is well the model stays out of sight, one click away on the bot's panel (the bot's name, Details, Model). */
export function SimpleHeadModel({ bot, folded }: { bot: Bot; folded: boolean }) {
  const instances = useStoreSelector((state) => state.instances);
  const selection = bot.modelSelection;
  const limit = useEngineLimits().find((candidate) => candidate.engine === selection.instanceId);
  const active = withTypedModels(instances, selection, "").find((instance) => instance.instanceId === selection.instanceId);
  // An engine the list no longer has (removed or hidden) needs the person too, once the list has loaded.
  const gone = instances.length > 0 && !active;
  const needed = gone || Boolean(modelAttention(active, selection)) || (reportsUsage(limit) && usageTone(limit!) !== "fine");
  return needed ? <ModelPicker bot={bot} threadId={bot.threadId} folded={folded} /> : null;
}
