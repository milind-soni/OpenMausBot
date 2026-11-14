// Screen 6 until more Clouds per account are sold: a calm word and the way to the one there is, never an error box.
import { Loader2 } from "lucide-react";
import type { CloudColor } from "../../../electron/cloud-buy.mjs";
import { t } from "@/lib/i18n";
import { ACTIONS, CloudTile, Heading, PRIMARY, QUIET, SCREEN } from "./parts";

export function OneCloudScreen({ name, color, busy, interest, openFailed, onInterest, onOpen }: {
  name: string; color: CloudColor; busy: boolean; interest: "sent" | "failed" | null; openFailed: boolean; onInterest: () => void; onOpen: () => void;
}) {
  return <div data-cloud-add="has-cloud" className={SCREEN}>
    <div className="flex flex-col gap-3">
      <CloudTile color={color} size={32} />
      <Heading title={t("cloudBuy.one.title")} sub={t("cloudBuy.one.sub", { name })} />
    </div>
    <div className={ACTIONS}>
      {interest !== "sent" && <button type="button" className={QUIET} disabled={busy} onClick={onInterest}>{t("cloudBuy.one.email")}</button>}
      <button type="button" className={PRIMARY} disabled={busy} onClick={onOpen}>{t("cloudBuy.setup.open", { name })}</button>
    </div>
    <div aria-live="polite" className="text-[13px] leading-[18px] empty:-mt-5">
      {interest === "sent" && <p className="text-ink-secondary">{t("cloudBuy.one.thanks")}</p>}
      {interest === "failed" && <p role="alert" className="text-danger">{t("cloudBuy.one.failed")}</p>}
      {openFailed && <p role="alert" className="text-danger">{t("cloudBuy.openFailed", { name })}</p>}
    </div>
  </div>;
}

/** Checking, Cloud out of reach, or a checkout that did not open: one line and one next step. */
export function StatusScreen({ kind, line, onRetry, onClose }: { kind: string; line: string | null; onRetry?: () => void; onClose: () => void }) {
  return <div data-cloud-add={kind} className={SCREEN}>
    <Heading title={t("cloudAdd.title")} />
    {line ? <p role="alert" className="text-[14px] leading-5 text-ink">{line}</p>
      : <p role="status" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{t("cloudAdd.checking")}</p>}
    <div className={ACTIONS}>
      <button type="button" className={QUIET} onClick={onClose}>{t("cloudAdd.close")}</button>
      {onRetry && <button type="button" className={PRIMARY} onClick={onRetry}>{t("cloudAdd.tryAgain")}</button>}
    </div>
  </div>;
}
