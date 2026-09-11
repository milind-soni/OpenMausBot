import { useEffect, useRef, useState } from "react";
import type { StudioHandoff, StudioTarget } from "../../../shared/live-team";
import { api, type Message } from "@/state/store";
import { t } from "@/lib/i18n";

export function StudioHandoffDetail({ handoff, sourceName, targetName, onClose, onOpen }: {
  handoff: StudioHandoff; sourceName: string; targetName: string; onClose: () => void; onOpen: (target: StudioTarget) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [request, setRequest] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    if (!handoff.sourceMessageId) { setError(true); return; }
    void api(`/api/threads/${encodeURIComponent(handoff.sourceThreadId)}/messages?around=${encodeURIComponent(handoff.sourceMessageId)}&limit=1`, { signal: controller.signal })
      .then((page: { messages: Message[] }) => {
        if (controller.signal.aborted) return;
        const message = page.messages.find((message) => message.id === handoff.sourceMessageId);
        const text = message?.tool?.summary ?? message?.text;
        if (text) setRequest(text); else setError(true);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [handoff.sourceThreadId, handoff.sourceMessageId]);
  return <dialog ref={dialog} className="studio-handoff-dialog" aria-labelledby="studio-handoff-title" onClose={onClose}>
    <header><h2 id="studio-handoff-title">{sourceName} → {targetName}</h2><button autoFocus onClick={onClose}>{t("studio.close")}</button></header>
    <p>{t(`studio.handoff.${handoff.state}`)}</p>
    <h3>{t("studio.actualRequest")}</h3>
    <div className="studio-request-text">{error ? t("studio.requestUnavailable") : request ?? t("studio.loading")}</div>
    <footer><button onClick={() => onOpen({ botId: handoff.sourceBotId, threadId: handoff.sourceThreadId, messageId: handoff.sourceMessageId })}>{t("studio.openSource")}</button>
      {handoff.targetThreadId && <button onClick={() => onOpen({ botId: handoff.targetBotId, threadId: handoff.targetThreadId! })}>{t("studio.openDestination")}</button>}</footer>
  </dialog>;
}
