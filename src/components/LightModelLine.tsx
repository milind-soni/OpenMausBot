import type { Message } from "@/state/store";
import { t } from "@/lib/i18n";

/** Under a direct reply the decision model sent to the engine's lighter
 * model because the message looked easy. */
export function LightModelLine({ routedBy }: { routedBy: NonNullable<Message["routedBy"]> }) {
  const percent = Math.round(Math.min(1, Math.max(0, routedBy.probability)) * 100);
  return (
    <div
      data-testid="light-model"
      className="mt-1 px-1 text-[11px] text-ink-secondary"
      title={t("chat.lightModelHint", { percent: String(percent), model: routedBy.model ?? "" })}
    >
      {t("chat.lightModel")}
    </div>
  );
}
