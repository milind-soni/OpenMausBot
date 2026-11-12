// The window's own preferences, as the server's app_settings tool reaches them: a `window-pref` frame is applied with
// the preference's setter, and every setter reports the current values back so a bot can read them.
import { WINDOW_PREFS, type WindowPrefFrame, type WindowPrefId } from "../../shared/app-settings";
import { applyChatWidth, readChatWidth } from "./chat-width";
import { applyFont, readFont } from "./fonts";
import { readAdvancedMode, setAdvancedMode } from "./interface-mode";
import { notificationSoundsEnabled, setNotificationSounds } from "./notification-preferences";
import { readSendKey, setSendKey } from "./send-key";
import { applySkinChoice, readSkinChoice } from "./skins";

const PREFS: Record<WindowPrefId, { read(): unknown; write(value: never): void }> = {
  "appearance.skin": { read: readSkinChoice, write: applySkinChoice },
  "appearance.advanced": { read: readAdvancedMode, write: setAdvancedMode },
  "appearance.font": { read: readFont, write: applyFont },
  "appearance.chatWidth": { read: readChatWidth, write: applyChatWidth },
  "general.sendKey": { read: readSendKey, write: setSendKey },
  "general.notificationSounds": { read: notificationSoundsEnabled, write: setNotificationSounds },
};

export function applyWindowPref(frame: WindowPrefFrame): void {
  const schema = WINDOW_PREFS[frame.id];
  const parsed = schema?.safeParse(frame.value);
  if (!parsed?.success) return;
  PREFS[frame.id].write(parsed.data as never);
}

export function windowPrefValues(): Record<WindowPrefId, unknown> {
  return Object.fromEntries((Object.keys(PREFS) as WindowPrefId[]).map((id) => [id, PREFS[id].read()])) as Record<WindowPrefId, unknown>;
}

let report: ReturnType<typeof setTimeout> | null = null;
/** Tells the server the window's values, once the burst of setters at start-up has settled. */
export function reportWindowPrefs(): void {
  if (typeof fetch !== "function" || typeof window === "undefined") return;
  if (report) clearTimeout(report);
  report = setTimeout(() => {
    report = null;
    fetch("/api/window-prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: windowPrefValues() }) }).catch(() => undefined);
  }, 200);
}
