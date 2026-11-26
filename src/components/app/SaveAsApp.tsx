import { useEffect, useState } from "react";
import { Check, Grid2x2Plus, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { loadLocalApps, openLocalApp, saveLocalApp, savedAppFor, useLocalApps } from "@/lib/local-apps";
import { useStoreDispatch } from "@/state/store-select";
import { ASK_CHIP, ASK_CHIP_IDLE } from "../AskCard";

const LIST_AFTER_MS = 1_500;

/** Save as app for a bot's page: saved with the page's title, no questions; once saved it opens the app instead. */
export function useSaveAsApp(page: { botId: string; threadId: string; messageId: string }, room?: boolean) {
  const dispatch = useStoreDispatch();
  const { apps } = useLocalApps();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // The page itself loads first; which pages are saved is read once for the whole window, a moment later.
  useEffect(() => {
    if (room || apps) return undefined;
    const timer = setTimeout(() => void loadLocalApps(), LIST_AFTER_MS);
    return () => clearTimeout(timer);
  }, [room, apps]);
  const saved = savedAppFor(apps, page.threadId, page.messageId);
  const open = (id: string) => {
    openLocalApp(id);
    dispatch({ type: "showPublishedApps" });
  };
  const save = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await saveLocalApp(page);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return { show: !room, saved, busy, failed, run: () => (saved ? open(saved.id) : void save()) };
}

export function SaveAsAppButton({ app }: { app: ReturnType<typeof useSaveAsApp> }) {
  if (!app.show) return null;
  return (
    <button type="button" data-page-save-app={app.saved ? "saved" : ""} onClick={app.run} disabled={app.busy}
      title={app.saved ? t("localApps.page.savedHint") : t("localApps.page.saveHint")}
      className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
      {app.busy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        : app.saved ? <Check size={14} aria-hidden="true" /> : <Grid2x2Plus size={14} aria-hidden="true" />}
      <span role="status">{app.saved ? t("localApps.page.saved") : t("localApps.page.save")}</span>
    </button>
  );
}
