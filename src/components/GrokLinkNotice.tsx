import { Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { copyText } from "@/lib/copy-text";
import { grokConnector, grokLinkSeen, NO_ARRIVALS } from "@/lib/grok-move";
import { t } from "@/lib/i18n";
import { GrokBotMark } from "./GrokBotMark";
import { NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

const OPENING_POLL_MS = 3_000;

/** The Grok Bot link when it came back on at a new address as the app started and the person has not copied it or closed
 * the notice; null when not, undefined until known. Asked again whenever the page reconnects, as the app may have started
 * again, and while the link opens, every few seconds until it has. */
export function useChangedGrokLink(here: boolean, connected: boolean): { url: string | null | undefined; seen: () => void } {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!here || !connected) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => void grokConnector("GET", NO_ARRIVALS).then((next) => {
      if (!active) return;
      if (next.opening) timer = setTimeout(look, OPENING_POLL_MS);
      else setUrl(next.changed && next.connectorUrl ? next.connectorUrl : null);
    }, () => { if (active) setUrl(null); });
    look();
    return () => { active = false; clearTimeout(timer); };
  }, [here, connected]);
  return { url: here ? url : null, seen: () => { setUrl(null); void grokLinkSeen().catch(() => {}); } };
}

/** The new link, its Copy and the way to Settings → Import. Copying it ends the notice, as closing it does. */
export function GrokLinkChangedCard({ url, onCopied, onSettings, onClose }: { url: string; onCopied: () => void; onSettings: () => void; onClose: () => void }) {
  const [failed, setFailed] = useState(false);
  const copy = () => void copyText(url).then((result) => (result === "copied" ? onCopied() : setFailed(true)));
  return <NoticeCard titleId="grok-link-changed-title" notice="grok-link-changed" icon={GrokBotMark} title={t("grokMove.linkChanged.title")}
    onDismiss={onClose} dismissLabel={t("common.close")}>
    <p className="mb-2 mt-1 text-[13px] leading-[18px] text-ink-secondary">{t("grokMove.linkChanged.body")}</p>
    <input readOnly value={url} aria-label={t("grokMove.connect.linkLabel")} onFocus={(event) => event.target.select()}
      className="mb-3 w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 font-mono text-[12px] text-ink focus:border-focus focus:outline-none" />
    {failed && <p role="alert" className="-mt-1 mb-2 text-[12px] text-danger">{t("grokMove.copyFailed")}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={PRIMARY_BUTTON} onClick={copy}><Copy size={14} aria-hidden="true" />{t("grokMove.connect.copy")}</button>
      <NotNowButton label={t("grokMove.linkChanged.settings")} onClick={onSettings} />
    </div>
  </NoticeCard>;
}
