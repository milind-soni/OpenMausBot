import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { hintSeen, hintSeenPatch } from "@/lib/onboarding";
import { api, useStore } from "@/state/store";

const COPY = { "spot.approval": "onboarding.hint.approval", "spot.connector": "onboarding.hint.connector" } as const;
const shownHere = new Set<string>();

/** A card drawn outside the app (a preview) has no record to go by, so no hint. */
function useStoreIfAny(): ReturnType<typeof useStore> | null {
  try {
    return useStore();
  } catch {
    return null;
  }
}

/** Simple mode's one-line hint on an approval or app card, the first time one shows (Advanced mode spotlights it
 * instead, FirstConversationTour). Seen once it shows, in the same record the spotlight uses. */
export function CardHint({ id }: { id: keyof typeof COPY }) {
  const store = useStoreIfAny();
  const dispatch = store?.dispatch;
  const advanced = useAdvancedMode();
  const record = store?.state.config?.onboarding;
  const [show] = useState(() => Boolean(dispatch) && !advanced && Boolean(record?.completedAt) && !hintSeen(record, id) && !shownHere.has(id));
  useEffect(() => {
    if (!show) return;
    shownHere.add(id);
    const patch = hintSeenPatch(record, id);
    if (!patch) return;
    void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then((config) => dispatch?.({ type: "configStatus", config }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);
  if (!show) return null;
  return <p data-card-hint={id} className="text-[12px] leading-4 text-ink-secondary">{t(COPY[id])}</p>;
}
