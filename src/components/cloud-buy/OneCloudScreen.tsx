// Screen 6 until more Clouds per account are sold: a calm word and the way to the one there is, never an error box.
import { Loader2 } from "lucide-react";
import type { CloudColor } from "../../../electron/cloud-buy.mjs";
import { t } from "@/lib/i18n";
import { CloudTile, Heading } from "./parts";

export function OneCloudScreen({ name, color, busy, interest, openFailed, onInterest, onOpen }: {
  name: string; color: CloudColor; busy: boolean; interest: "sent" | "failed" | null; openFailed: boolean; onInterest: () => void; onOpen: () => void;
}) {
  return <div data-cloud-add="has-cloud" className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7">
    <CloudTile color={color} size={36} />
    <Heading title={t("cloudBuy.one.title")} sub={t("cloudBuy.one.sub", { name })} />
    <div className="flex flex-wrap items-center justify-end gap-2">
      {interest !== "sent" && <button type="button" className="ui-button" disabled={busy} onClick={onInterest}>{t("cloudBuy.one.email")}</button>}
      <button type="button" className="ui-button ui-button-primary" disabled={busy} onClick={onOpen}>{t("cloudBuy.setup.open", { name })}</button>
    </div>
    <div aria-live="polite" className="text-[13px] empty:-mt-4">
      {interest === "sent" && <p className="text-ink-secondary">{t("cloudBuy.one.thanks")}</p>}
      {interest === "failed" && <p role="alert" className="text-danger">{t("cloudBuy.one.failed")}</p>}
      {openFailed && <p role="alert" className="text-danger">{t("cloudBuy.openFailed", { name })}</p>}
    </div>
  </div>;
}

/** Checking, Cloud out of reach, or a checkout that did not open: one line and one next step. */
export function StatusScreen({ kind, line, onRetry, onClose }: { kind: string; line: string | null; onRetry?: () => void; onClose: () => void }) {
  return <div data-cloud-add={kind} className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7">
    <Heading title={t("cloudAdd.title")} />
    {line ? <p role="alert" className="text-[14px] leading-relaxed text-ink">{line}</p>
      : <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{t("cloudAdd.checking")}</p>}
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button type="button" className="ui-button" onClick={onClose}>{t("cloudAdd.close")}</button>
      {onRetry && <button type="button" className="ui-button ui-button-primary" onClick={onRetry}>{t("cloudAdd.tryAgain")}</button>}
    </div>
  </div>;
}
