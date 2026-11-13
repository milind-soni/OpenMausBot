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
export interface AppSettingCardField {
  /** A bot's change to one of the app's own settings: applied with Undo, or waiting on Change/Cancel. */
  appSettingRequest?: AppSettingRequest;
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
export const PLACE_SWATCHES = ["blue", "green", "amber", "rose", "violet", "slate"] as const;
export const TALK_KEYS = ["ctrl-opt-space", "ctrl-shift-space", "opt-shift-space"] as const;
const pinnedPage = z.object({ name: z.string().trim().min(1).max(40), url: z.string().trim().max(2048).regex(/^https?:\/\/\S+$/, "an http(s) address") }).strict();

/** Preferences kept in the window or behind the desktop app's own bridge, by setting id; the renderer applies a frame with
 * the matching setter. */
export const WINDOW_PREFS = {
  "appearance.skin": z.enum([...SKIN_IDS, "system"]),
  "appearance.advanced": z.boolean(),
  "appearance.font": z.enum(FONT_IDS),
  "appearance.chatWidth": z.enum(CHAT_WIDTH_IDS),
  "general.sendKey": z.enum(SEND_KEYS),
  "general.notificationSounds": z.boolean(),
  "appearance.userBubbles": z.boolean(),
  "appearance.runCard": z.boolean(),
  "appearance.showThreads": z.boolean(),
  "appearance.toolsLayout": z.enum(["rows", "toolbar"]),
  "appearance.pinnedCircles": z.boolean(),
  "appearance.universalPins": z.boolean(),
  "appearance.pinnedPages": z.array(pinnedPage).max(6),
  "appearance.showComputers": z.boolean(),
  "appearance.windowFrame": z.boolean(),
  "appearance.sidebarColor": z.enum([...PLACE_SWATCHES, "none"]),
  "general.followUp": z.enum(["steer", "queue"]),
  "general.finishedNotifications": z.boolean(),
  "general.notificationFeed": z.boolean(),
  "general.analytics": z.boolean(),
  "general.openAtLogin": z.boolean(),
  "general.talkShortcut": z.object({ enabled: z.boolean(), key: z.enum(TALK_KEYS) }).strict(),
  "account.productEmails": z.boolean(),
  "remote.wifi": z.boolean(),
  "remote.relay": z.boolean(),
  "remote.tailscale": z.boolean(),
  "remote.keepAwake": z.boolean(),
  "remote.httpsAddress": z.boolean(),
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
