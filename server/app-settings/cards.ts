// The settings a bot can ask the app to show in chat as the real control (app_settings show_card). The bot picks an id
// from this list and hears one fixed status back. The person works the control; the row stores the id and fixed words.
import type { SettingsCardId } from "../../shared/app-settings.ts";

export interface SettingsCard {
  label: string;
  where: string;
  /** For the tool's schema: the questions this card answers. */
  when: string;
  /** The row's text: what a client without the control shows, and all a bot ever reads of the card. */
  text: string;
  /** What the bot is told to say around the card. */
  guide: string;
}

export const SETTINGS_CARDS: Record<SettingsCardId, SettingsCard> = {
  "other-computers": {
    label: "Your other computers",
    where: "Settings → Phone & devices",
    when: "when the person asks how to connect or open this computer from another computer",
    text: "Your other computers: this is turned on in MausBot on the computer itself, in Settings → Phone & devices.",
    guide: "Tell the user in two or three plain sentences: turn it on in the card (both computers need Tailscale, signed in to the same Tailscale account), choose Pair a computer and Copy link, then on the other computer open Connect to a server in MausBot and paste the link.",
  },
};

/** Fixed words only: the state is a yes or no the server already holds, never the address. */
export function cardShownStatus(card: SettingsCard, on: boolean | null): string {
  const state = on === null ? "" : on ? ` ${card.label} is on now.` : ` ${card.label} is off now.`;
  return `Card shown: ${card.label}.${state} Only the user can change it, in the card; you cannot, and you never see what it shows. ${card.guide}`;
}

export function cardElsewhere(card: SettingsCard): string {
  return `No card shown: ${card.label} is set in the MausBot desktop app on the computer itself, in ${card.where}. Tell the user that in one line.`;
}
