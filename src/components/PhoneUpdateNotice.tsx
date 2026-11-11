import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import type { CompanionState, PhoneDevice } from "@/lib/companion-types";
import { t } from "@/lib/i18n";
import { noticeSeen, phoneUpdateHint } from "@/lib/notices";
import type { OnboardingStatus } from "@/lib/onboarding";
import { olderAppPhones, showTunnelRetiredNotice } from "@/lib/phone-link";
import type { CompanionAccountState } from "../types/ogb";
import { NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

type Bridges = { companion?: { state: () => Promise<CompanionState> }; companionAccount?: { state: () => Promise<CompanionAccountState> } };
// SAFETY: main answers these narrow preload bridges only for this computer's own page.
const bridges = (): Bridges => (typeof window === "undefined" ? {} : (window.ogb as Bridges | undefined) ?? {});

/** Phones on an older app once this computer's secure link ended: undefined until known, [] when none. The account (which
 * may ask the control plane) is read only when a phone has an older app. */
export function useRetiredLinkPhones(here: boolean): PhoneDevice[] | undefined {
  const [phones, setPhones] = useState<PhoneDevice[] | undefined>(here ? undefined : []);
  useEffect(() => {
    const { companion, companionAccount: account } = here ? bridges() : {};
    if (!companion || !account) { setPhones([]); return; }
    let active = true;
    void (async () => {
      const state: CompanionState | undefined = await Promise.resolve().then(() => companion.state()).catch(() => undefined);
      if (!olderAppPhones(state).length) return [];
      const linked = await Promise.resolve().then(() => account.state()).catch(() => undefined);
      return showTunnelRetiredNotice(linked ?? null, state ?? null) ? olderAppPhones(state) : [];
    })().then(next => { if (active) setPhones(next); });
    return () => { active = false; };
  }, [here]);
  return here ? phones : [];
}

export function phonesToTell(phones: PhoneDevice[] | undefined, record: OnboardingStatus | undefined): PhoneDevice[] | undefined {
  return phones?.filter(phone => !noticeSeen(record, phoneUpdateHint(phone.id)));
}

export function PhoneUpdateCard({ phones, onOpen, onDismiss }: { phones: PhoneDevice[]; onOpen: () => void; onDismiss: () => void }) {
  const body = phones.length === 1 ? t("phoneUpdate.body", { phone: phones[0]!.name }) : t("phoneUpdate.bodyMany", { count: phones.length });
  return <NoticeCard titleId="phone-update-title" notice="phone-update" icon={Smartphone} title={t("phoneUpdate.title")} onDismiss={onDismiss}>
    <p className="mb-3 mt-1 text-[13px] leading-[18px] text-ink-secondary">{body}</p>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={PRIMARY_BUTTON} onClick={onOpen}>{t("phoneUpdate.open")}</button>
      <NotNowButton onClick={onDismiss} />
    </div>
  </NoticeCard>;
}
