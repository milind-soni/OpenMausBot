// A setting's own control in the conversation (app_settings show_card). The row names the setting; the control reads
// and changes the app directly, so nothing it shows goes through the bot. Where the setting belongs to another computer
// than the one this window is on, the card says where it is set and draws no switches.
import { lazy, Suspense, type ReactNode } from "react";

import { pageIsThisComputer } from "@/lib/companion-bridge";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import type { SettingsCardId } from "../../shared/app-settings";
import { SettingsLook } from "./SettingsPrimitives";

const OtherComputersSetting = lazy(() => import("./TailnetComputers").then((module) => ({ default: module.OtherComputersSetting })));
const AiSignIn = lazy(() => import("./EnginesSettings").then((module) => ({ default: module.AiSignInSettings })));

const CARDS: Record<SettingsCardId, { here: () => boolean; control: () => ReactNode }> = {
  "other-computers": { here: pageIsThisComputer, control: () => <OtherComputersSetting /> },
  "ai-sign-in": { here: () => true, control: () => <AiSignIn /> },
};

export function SettingsCard({ message }: { message: Message }) {
  const card = message.settingsCard && Object.hasOwn(CARDS, message.settingsCard.id) ? CARDS[message.settingsCard.id] : null;
  if (!card) return <p dir="auto" className="max-w-[600px] text-[15px] leading-relaxed text-ink">{message.text}</p>;
  if (!card.here()) return <p data-settings-card={message.settingsCard!.id} data-settings-card-elsewhere="" className="max-w-[600px] text-[15px] leading-relaxed text-ink">{t("chat.settingsCard.elsewhereDevices")}</p>;
  return (
    <SettingsLook.Provider value={true}>
      <div data-settings-card={message.settingsCard!.id} data-settings-look="simple" className="flex w-full max-w-[600px] flex-col gap-2"><Suspense fallback={null}>{card.control()}</Suspense></div>
    </SettingsLook.Provider>
  );
}
