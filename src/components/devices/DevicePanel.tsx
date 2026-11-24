import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import { BotAvatar } from "@/components/Avatar";
import type { Device, DeviceAction } from "@/lib/devices";
import { t } from "@/lib/i18n";
import { vpsServerId } from "../../../shared/bot-computers";
import { VpsServerEditor } from "../keys/VpsServerEditor";
import { ActionButton, DeviceDetails, primaryOf } from "./DeviceList";
import { StatusLine, useBotsOn } from "./DeviceTile";
import { KIND_ICON } from "./device-words";

/** A server bots reach over SSH: the id its editor takes. */
export const vpsOf = (device: Device): string | null => {
  const source = device.sources.find((one) => one.type === "vps");
  return source ? vpsServerId(source.id) : null;
};

/**
 * The chosen device's card, drawn against the map where it was chosen: its state and its one button, the bots on it,
 * its details and other actions, and for a server bots reach over SSH its own editor.
 */
export function DevicePanel({ device, onAction, onClose, onRemoved, caret, children, now = Date.now() }: {
  device: Device; onAction: (device: Device, action: DeviceAction) => void; onClose: () => void; onRemoved: (notice: string | null) => void;
  /** Where the chosen tile sits along the card's top edge, in px from its start; null draws no pointer. */
  caret: number | null; children?: ReactNode; now?: number;
}) {
  const Icon = KIND_ICON[device.kind];
  const primary = primaryOf(device);
  const bots = useBotsOn(device);
  const vps = vpsOf(device);
  const card = useRef<HTMLElement>(null);
  useEffect(() => { card.current?.scrollIntoView?.({ block: "nearest" }); }, [device.id]);
  return (
    <section ref={card} id="device-card" data-device-card={device.id} aria-label={device.name} style={caret === null ? undefined : { "--caret": `${caret}px` } as CSSProperties}
      className="relative flex scroll-mt-4 flex-col gap-3 rounded-xl bg-menu px-4 py-3 shadow-[inset_0_0_0_0.5px_var(--settings-edge)] motion-safe:animate-fade-in">
      {caret !== null && <span aria-hidden="true" className="absolute -top-[5px] start-(--caret) size-2.5 -translate-x-1/2 rotate-45 border-s-[0.5px] border-t-[0.5px] border-(--settings-edge) bg-menu rtl:translate-x-1/2" />}
      <div className="flex items-center gap-3">
        <Icon size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] font-medium leading-5 text-ink">{device.name}</span>
          <StatusLine device={device} now={now} />
        </div>
        {primary && <ActionButton device={device} action={primary} quiet={false} onAction={onAction} />}
        <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} className="ui-icon-button shrink-0"><X size={16} aria-hidden="true" /></button>
      </div>
      <div className="flex flex-col gap-3 ps-7">
        {bots.length > 0 && (
          <div data-device-bot-names="" className="flex flex-col gap-1.5">
            <span className="text-[12px] leading-4 text-ink-tertiary">{t("devicesPage.bots.title")}</span>
            <ul className="flex flex-wrap gap-x-3 gap-y-1.5">
              {bots.map((bot) => <li key={bot.id} className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-ink"><BotAvatar bot={bot} size={18} /><span className="truncate">{bot.name}</span></li>)}
            </ul>
          </div>
        )}
        <DeviceDetails device={device} actions={device.actions.filter((action) => action !== primary)} onAction={onAction} now={now} />
        {vps && <VpsServerEditor serverId={vps} onRemoved={onRemoved} />}
        {children}
      </div>
    </section>
  );
}
