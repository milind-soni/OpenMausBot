import { useEffect, useRef, useState } from "react";
import { api, type Message } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";
import { t } from "@/lib/i18n";
import { replyAuthor } from "@/lib/replies";
import { ReplyQuote } from "../ReplyQuote";
import { ChatMarkdown } from "../ChatMarkdown";

type Source = { message: Message; onActivePath: boolean };

export function UnloadedReplyQuote({ threadId, messageId, botName, inverse, canJump, pending, onJump }: {
  threadId: string; messageId: string; botName: string; inverse: boolean;
  canJump: boolean; pending: boolean; onJump: () => void;
}) {
  const generation = useStoreSelector(state => state.transcriptGeneration[threadId] ?? 0);
  const [loaded, setLoaded] = useState<{ generation: number; source: Source }>();
  const source = loaded?.generation === generation ? loaded.source : undefined;
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<Source>(`/api/threads/${threadId}/messages?view=quote&around=${encodeURIComponent(messageId)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setLoaded({ generation, source: result }); })
      .catch(() => {});
    return () => controller.abort();
  }, [threadId, messageId, generation]);

  if (!source) return canJump && <button type="button" disabled={pending}
    className="mb-2 block text-start text-[13px] underline disabled:opacity-60"
    onClick={onJump}>{t("chat.reply.jump")}</button>;

  const name = replyAuthor(source.message, botName);
  return <div className="mb-2">
    <ReplyQuote message={source.message} fallbackName={botName} compact inverse={inverse} onJump={() => {
      if (source.onActivePath && canJump) {
        if (!pending) onJump();
      } else dialog.current?.showModal();
    }} />
    <dialog ref={dialog} aria-label={t("chat.citation.quoted")}
      className="fading-dialog m-auto max-h-[80dvh] w-[min(36rem,calc(100%-2rem))] overflow-auto rounded-2xl bg-panel p-5 text-ink shadow-xl backdrop:bg-black/50">
      <div className="mb-3 flex items-center justify-between gap-4">
        <strong>{name}</strong>
        <form method="dialog"><button className="rounded-md px-2 py-1 hover:bg-raised">{t("common.close")}</button></form>
      </div>
      <ChatMarkdown text={source.message.text ?? ""} message={{ threadId, messageId }} />
    </dialog>
  </div>;
}
