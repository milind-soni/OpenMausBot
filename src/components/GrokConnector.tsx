import { Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useCopyFeedback } from "@/lib/copy-text";
import { grokConnector, NO_ARRIVALS, type GrokConnector, type GrokHandoff } from "@/lib/grok-move";
import { t } from "@/lib/i18n";
import { localSetupImport } from "@/lib/setup-import";
import { useShowThreads } from "@/lib/thread-preferences";
import type { LocaleKey } from "@/locales";
import { openThread, useStore } from "@/state/store";
import { GrokBotMark } from "./GrokBotMark";
import { SettingRow, SettingsMark } from "./SettingsPrimitives";

const LINE = "text-[13px] leading-relaxed text-ink-secondary";
const POLL_MS = 3_000;
const STATE: Record<GrokHandoff["state"], LocaleKey> = {
  working: "grokMove.connector.working",
  needs_you: "grokMove.connector.needsYou",
  done: "grokMove.connector.done",
  failed: "grokMove.connector.failed",
  stopped: "grokMove.connector.stopped",
};

/** The link to paste into Grok Bot, its Copy button and where it goes: the same in the move and in Settings. */
export function GrokLink({ url, where = "grokMove.connect.where" }: { url: string; where?: LocaleKey }) {
  const { state: copied, copy } = useCopyFeedback(url);
  return (
    <>
      <div className="mt-1 flex w-full items-center gap-2">
        <input readOnly value={url} aria-label={t("grokMove.connect.linkLabel")} onFocus={(event) => event.target.select()}
          className="min-w-0 flex-1 rounded-xl border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink focus:outline-none" />
        <button type="button" data-grok-move-copy-link onClick={copy} className="ui-button inline-flex min-h-9 shrink-0 items-center gap-2 px-4 text-[14px]">
          {copied === "copied" ? <Check size={15} /> : <Copy size={15} />}
          {copied === "copied" ? t("grokMove.copied") : copied === "failed" ? t("grokMove.copyFailed") : t("grokMove.connect.copy")}
        </button>
      </div>
      <p className={LINE}>{t(where)}</p>
    </>
  );
}

/** Settings → Import: the Grok Bot connector, on until it is turned off, and the last tasks Grok Bot handed off. */
export function GrokConnectorPart() {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const local = localSetupImport(state.config?.cloudHome === true);
  const [connector, setConnector] = useState<GrokConnector | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!local) return;
    const look = () => void grokConnector("GET", NO_ARRIVALS).then(setConnector, () => {});
    look();
    const timer = setInterval(look, POLL_MS);
    return () => clearInterval(timer);
  }, [local]);

  if (!local || !connector?.available) return null;
  const url = connector.connectorUrl;
  const turnOn = async () => {
    setBusy(true);
    setFailed(false);
    await grokConnector("POST").then(setConnector, () => setFailed(true));
    setBusy(false);
  };
  const turnOff = () => void grokConnector("DELETE").then(setConnector, () => {});

  return (
    <div data-import-section="grok-connector" className="flex flex-col">
      <SettingRow title={t("grokMove.connector.title")} subtitle={t(url ? "grokMove.connector.on" : "grokMove.connector.off")}
        leading={<SettingsMark><GrokBotMark size={18} /></SettingsMark>}
        message={failed ? <span role="alert" className="text-danger">{t("grokMove.connect.failed")}</span>
          : connector.stopped && !url ? <span role="status" data-grok-move-stopped>{t("grokMove.connect.stopped")}</span> : undefined}>
        {url ? (
          <button type="button" data-grok-connector-off className="ui-button" onClick={turnOff}>{t("grokMove.connector.turnOff")}</button>
        ) : (
          <button type="button" data-grok-connector-on className="ui-button gap-1.5" disabled={busy || connector.opening} onClick={() => void turnOn()}>
            {(busy || connector.opening) && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}{t("grokMove.connect.start")}
          </button>
        )}
      </SettingRow>
      {url && <div className="flex flex-col items-start gap-1.5 px-4 pb-3"><GrokLink url={url} where="grokMove.connector.where" /></div>}
      {connector.handoffs.length > 0 && (
        <section data-grok-handoffs className="flex flex-col px-2 pb-3">
          <h4 className="px-2 py-1 text-[12px] font-medium leading-4 text-ink-tertiary">{t("grokMove.connector.recent")}</h4>
          <ul className="flex flex-col">
            {connector.handoffs.map((handoff) => (
              <li key={handoff.threadId}>
                <button type="button" data-grok-handoff={handoff.threadId} title={handoff.title}
                  onClick={() => openThread(dispatch, handoff, state, showThreads)}
                  className="flex min-h-8 w-full items-center gap-3 rounded-lg px-2 text-start text-[13px] leading-[18px] text-ink transition-colors hover:bg-ink/[0.06] active:bg-ink/[0.08] motion-reduce:transition-none">
                  <span dir="auto" className="min-w-0 flex-1 truncate">{handoff.title}</span>
                  <span className="shrink-0 text-[12px] leading-4 text-ink-secondary">{t(STATE[handoff.state])}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
