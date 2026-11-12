// The app_settings tool's wire shapes: a setting's tier (the whole policy), the card a change rides on, and the
// preferences that live in the window's localStorage, which the server reaches through an SSE frame.
import { z } from "zod";

export type SettingTier = "safe" | "confirm" | "secret" | "owner-only";

/** On a card: display values only, never a key. */
export interface AppSettingRequest {
  settingId: string;
  label: string;
  before?: string;
  after: string;
  tier: SettingTier;
}

export const SKIN_IDS = [
  "midnight",
  "atelier",
  "foundry",
  "lagoon",
  "graphite",
  "linen",
  "dusk",
  "daylight",
  "meadow",
  "pop",
  "halloween",
  "diwali",
  "aurora",
] as const;
export const FONT_IDS = ["skin", "system", "inter", "poppins", "serif"] as const;
export const CHAT_WIDTH_IDS = ["standard", "wide", "full"] as const;
/** The Enter-adds-a-line modes are for input methods that confirm a conversion with Enter (Japanese). */
export const SEND_KEYS = ["enter", "shift-enter", "mod-enter"] as const;

/** Preferences kept in the window, by setting id; the renderer applies a frame with the matching setter. */
export const WINDOW_PREFS = {
  "appearance.skin": z.enum([...SKIN_IDS, "system"]),
  "appearance.advanced": z.boolean(),
  "appearance.font": z.enum(FONT_IDS),
  "appearance.chatWidth": z.enum(CHAT_WIDTH_IDS),
  "general.sendKey": z.enum(SEND_KEYS),
  "general.notificationSounds": z.boolean(),
} as const;
export type WindowPrefId = keyof typeof WINDOW_PREFS;
export type WindowPrefValue<I extends WindowPrefId> = z.infer<(typeof WINDOW_PREFS)[I]>;
export const WINDOW_PREF_IDS = Object.keys(WINDOW_PREFS) as WindowPrefId[];
export const isWindowPrefId = (id: string): id is WindowPrefId => Object.hasOwn(WINDOW_PREFS, id);

export interface WindowPrefFrame {
  kind: "window-pref";
  id: WindowPrefId;
  value: unknown;
}

/** What the window reports as its current values (PUT /api/window-prefs). */
export const windowPrefReportSchema = z.object({ values: z.record(z.string(), z.unknown()) }).strict();
