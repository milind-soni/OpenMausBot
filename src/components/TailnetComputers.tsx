import { t } from "@/lib/i18n";
import { productName } from "../lib/brand";
import type { TailnetShareState } from "../lib/companion-types";
import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";
import { ServerPairingCard } from "./ServerPairingCard";

const button = "rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40";

/** What the row says about the share right now; null while it is off. */
export function tailnetShareLine(share: TailnetShareState | undefined): string | null {
  if (!share?.on) return null;
  if (!share.origin) return t("devices.computers.waiting", { app: productName() });
  return t(share.https ? "devices.computers.https" : "devices.computers.http", { address: share.origin });
}

/** Under the Tailscale route: lets the person's other computers open this one, and makes them a pairing code. */
export function TailnetComputers({ c, state, blocked, simple }: { c: PhoneSetupController; state: CompanionState; blocked: string | null; simple: boolean }) {
  const on = state.routes?.tailscale?.computers === true;
  const line = tailnetShareLine(state.tailnetShare);
  return (
    <div className="flex flex-col gap-3 border-t border-hairline/30 pt-4" data-route-row="tailscale-computers">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] text-ink">{t("devices.computers.title")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("devices.computers.detail")}</div>
          {on && line && <div data-tailnet-share className="mt-1 break-words text-[12px] leading-relaxed text-ink" aria-live="polite">{line}</div>}
        </div>
        <button type="button" className={button} disabled={c.busy || c.accountBusy || (Boolean(blocked) && !on)} title={blocked ?? undefined}
          onClick={() => void c.act((companion) => companion.setTailscaleComputers?.(!on) ?? companion.state())}>
          {on ? t("devices.route.turnOff") : t("devices.route.turnOn")}
        </button>
      </div>
      {on && state.tailnetShare?.origin && <ServerPairingCard simple={simple} reveal={false} />}
    </div>
  );
}
