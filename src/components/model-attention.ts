import { isCustomOnly } from "@/lib/engine-rail";
import { t } from "@/lib/i18n";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { needsCli, needsSignIn } from "./EngineSetup";

/** What is wrong with the AI a model pick runs on, in one line, or undefined when nothing is: set up, sign in, blocked
 * by the organization, or an update the engine needs. The model button marks it with a dot. */
export function modelAttention(active: InstanceInfo | undefined, selection: Pick<ModelSelection, "model">): string | undefined {
  // An engine not reported yet (no snapshot) has nothing to say.
  if (!active?.snapshot) return undefined;
  const current = active.models?.options.find((option) => option.id === selection.model);
  if (active.policy) return t("policy.managedBy", { organization: active.policy.organizationName });
  if (needsCli(active)) return t("model.setupRequired");
  if (needsSignIn(active) && !isCustomOnly(active) && !current?.custom) return t("model.signInRequired");
  if (current?.orgBlocked) return t("model.orgBlocked");
  return current?.needsCliUpdate ? t("engines.updateClaude") : undefined;
}
