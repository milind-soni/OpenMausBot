import { useEffect, useState } from "react";
import { ArrowUpRight, Cloud, Laptop } from "lucide-react";
import { t } from "@/lib/i18n";
import { phoneAppChips, type PublicPhone } from "@/lib/phones";
import type { SessionState } from "@/lib/session";
import { api } from "@/state/api";
import { ComputerNameRow } from "../ComputerNameRow";
import { PlaceMark } from "../PlacesRail";
import { pairingBlockedReason } from "../ServerPairingCard";
import { SettingsGroup, SettingsLinkRow, SettingsMark, SettingsRows } from "../SettingsPrimitives";
import { useCloudPhoneDestination } from "../SidebarProfileMenu";
import { TeamPhoneCard } from "../TeamPhoneCard";
import { useOtherPlaces } from "../settings/settings-context";
import { useSettingsShell } from "../settings/settings-shell";
import { Detail } from "./DeviceDetails";

/** This computer's door to pairing with My Cloud, the first row of Phones and tablets: My Cloud opens with its own Add a
 * phone. Null while there is no ready Cloud to pair with. */
export function PairWithCloudRow() {
  const { cloud, bridge } = useCloudPhoneDestination(true);
  const others = useOtherPlaces();
  const [failed, setFailed] = useState(false);
  if (cloud !== "ready" || !bridge) return null;
  const home = others.find((place) => place.kind === "cloud") ?? null;
  const name = home?.name || t("cloudSetup.myCloud");
  return (
    <button type="button" data-settings-block="pair-cloud" data-pair-with-cloud="" onClick={() => { setFailed(false); void bridge.connectHomeForPhone().catch(() => setFailed(true)); }}
      className="flex min-h-16 w-full cursor-pointer items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-menu-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
      <span className="flex size-8 shrink-0 items-center justify-center">
        <PlaceMark place={{ kind: "cloud", name, color: home?.color ?? null }} size={24} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium leading-5 text-ink">{t("phone.pair.withPlace", { place: name })}</span>
        <span className="text-[13px] leading-[18px] text-ink-secondary">{t("phone.pair.withPlaceLine", { place: name })}</span>
        {failed && <span role="alert" className="text-[12px] leading-4 text-danger">{t("cloudPhone.failed")}</span>}
      </span>
      <ArrowUpRight size={12} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
    </button>
  );
}

/** The way to each other place's phones, one row each, marked like a device row. A Cloud already offered by Pair with
 * My Cloud is left out, so the page never has two doors to the same place's phones. */
export function OtherPlacesSection() {
  const { ctx } = useSettingsShell();
  const { cloud, bridge } = useCloudPhoneDestination(ctx.here);
  const callout = ctx.here && cloud === "ready" && Boolean(bridge);
  const others = useOtherPlaces("phone").filter((place) => !(callout && place.kind === "cloud"));
  if (!ctx.desktop || ctx.client || others.length === 0) return null;
  return (
    <SettingsGroup label={t("devicesPage.otherPlaces.title")} block="other-places">
      <SettingsRows icons>
        {others.map((place) => (
          <SettingsLinkRow key={place.key} title={place.name} subtitle={t("devicesPage.otherPlaces.line")}
            leading={<SettingsMark>{place.kind === "computer" ? <Laptop /> : <Cloud />}</SettingsMark>}
            external onClick={place.open} data={{ "data-other-place": place.key }} />
        ))}
      </SettingsRows>
    </SettingsGroup>
  );
}

/** What a Cloud's or server's Phones and tablets says before its rows: a team member's own phone card, or why this
 * session or place makes no codes. */
export function ServerPhoneNotes({ session, pairingCodes, team, teamBlocked }: {
  session: SessionState | null; pairingCodes: boolean | null; team: string | null; teamBlocked: string | null;
}) {
  if (team && session?.kind === "session" && session.team) return <div data-team-phone=""><TeamPhoneCard team={team} blocked={teamBlocked} /></div>;
  if (pairingBlockedReason(session) === "chat-only") {
    return <p data-server-pairing-chat-only="" className="px-4 text-[12px] leading-4 text-ink-secondary">{t(pairingCodes === false ? "remote.serverPairing.portalChatOnly" : "remote.serverPairing.chatOnly")}</p>;
  }
  if (pairingCodes === false) return <p data-server-pairing-portal="" className="px-4 text-[12px] leading-4 text-ink-secondary">{t("remote.serverPairing.portal")}</p>;
  return null;
}

/** What a paired phone calls this server, in Advanced, under its own row. */
export function ComputerNameMore() {
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api<{ computerName?: unknown }>("/api/config").then((config) => { if (alive) setSaved(typeof config?.computerName === "string" ? config.computerName : ""); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (saved === null) return null;
  return <div data-settings-block="computer-name"><ComputerNameRow saved={saved} onSaved={setSaved} className="px-4 py-3" /></div>;
}

/** A phone app's capabilities, as its details list them. */
export function PhoneAppFacts({ phone }: { phone: PublicPhone }) {
  const chips = phoneAppChips(phone);
  if (!chips.length) return null;
  return (
    <Detail label={t("devicesPage.detail.phoneShares")}>
      <span data-phone-app-chips="" className="flex flex-wrap gap-1.5">
        {chips.map((cap) => <span key={cap} className="rounded-full bg-control px-2 py-0.5 text-[11px] text-ink-secondary">{t(`botAccess.phone.cap.${cap}`)}</span>)}
      </span>
    </Detail>
  );
}
