// The window's own preferences, as the server's app_settings tool reaches them: a `window-pref` frame is applied with
// the preference's setter, and every setter reports the current values back so a bot can read them. Some live behind the
// desktop app's bridge; where that bridge is absent they read as undefined, which the server takes as "not here".
import { WINDOW_PREFS, type WindowPrefFrame, type WindowPrefId, type WindowPrefValue } from "../../shared/app-settings";
import { analyticsEnabled, setAnalyticsEnabled } from "./analytics";
import { applyChatWidth, readChatWidth } from "./chat-width";
import { companionBridge, pageIsThisComputer } from "./companion-bridge";
import type { CompanionRoute } from "./companion-types";
import { applyFont, readFont } from "./fonts";
import { readFollowUpDefault, setFollowUpDefault } from "./follow-up";
import { readAdvancedMode, setAdvancedMode } from "./interface-mode";
import { finishedNotificationsEnabled, notificationFeedEnabled, notificationSoundsEnabled, setFinishedNotifications, setNotificationFeed, setNotificationSounds } from "./notification-preferences";
import { requestNotificationPermission } from "./notify";
import { choosePlaceColor } from "./place-look";
import { setShowRunCard, showRunCard } from "./run-card-preferences";
import { readSendKey, setSendKey } from "./send-key";
import { loadPinnedCircles, loadSidebarToolsLayout, loadUniversalPins, setPinnedCircles, setSidebarToolsLayout, setUniversalPins } from "./sidebar-preferences";
import { applySkinChoice, readSkinChoice } from "./skins";
import { setShowThreads, showThreads } from "./thread-preferences";
import { readColorUserBubbles, setColorUserBubbles } from "./user-bubble-preference";
import { latestWebPanels, setWebPanels } from "./web-panel-preferences";
import { newWebPanelId, validateWebPanel, type WebPanel } from "./web-panels";
import { onWindowPrefChanged } from "./window-pref-changes";

type Pref<I extends WindowPrefId> = { read(): unknown; write(value: WindowPrefValue<I>): unknown };
const ogb = () => (typeof window === "undefined" ? undefined : window.ogb);
const companion = () => (pageIsThisComputer() ? companionBridge() : null);
const route = (name: CompanionRoute): { read(): unknown; write(on: boolean): unknown } => ({
  read: async () => (await companion()?.state())?.routes?.[name]?.on,
  write: (on) => {
    const bridge = companion();
    if (!bridge) return;
    if (name === "tailscale") return bridge.setTailscale ? bridge.setTailscale(on) : on ? bridge.refreshTailscale() : bridge.state();
    return bridge.setRoute ? bridge.setRoute(name, on) : on ? bridge.start([name]) : bridge.state();
  },
});

// Called, never referenced at load: many tests mock these modules with only the exports they use.
const PREFS: { [I in WindowPrefId]: Pref<I> } = {
  "appearance.skin": { read: () => readSkinChoice(), write: (choice) => applySkinChoice(choice) },
  "appearance.advanced": { read: () => readAdvancedMode(), write: (on) => setAdvancedMode(on) },
  "appearance.font": { read: () => readFont(), write: (font) => applyFont(font) },
  "appearance.chatWidth": { read: () => readChatWidth(), write: (width) => applyChatWidth(width) },
  "general.sendKey": { read: () => readSendKey(), write: (key) => setSendKey(key) },
  "general.notificationSounds": { read: () => notificationSoundsEnabled(), write: (on) => setNotificationSounds(on) },
  "appearance.userBubbles": { read: () => readColorUserBubbles(), write: (on) => setColorUserBubbles(on) },
  "appearance.runCard": { read: () => showRunCard(), write: (on) => setShowRunCard(on) },
  "appearance.showThreads": { read: () => showThreads(), write: (on) => setShowThreads(on) },
  "appearance.toolsLayout": { read: () => loadSidebarToolsLayout(), write: (layout) => setSidebarToolsLayout(layout) },
  "appearance.pinnedCircles": { read: () => loadPinnedCircles(), write: (on) => setPinnedCircles(on) },
  "appearance.universalPins": { read: () => loadUniversalPins(), write: (on) => setUniversalPins(on) },
  "appearance.pinnedPages": {
    read: () => latestWebPanels().flatMap((panel) => (panel.url === undefined ? [] : [{ name: panel.name, url: panel.url }])),
    write: (pages) => {
      // Chat pages pinned from a conversation stay; only the web pages are replaced.
      const next: WebPanel[] = latestWebPanels().filter((panel) => panel.url === undefined);
      for (const page of pages) {
        const check = validateWebPanel(page, window.location.origin);
        if (!check.ok) return;
        next.push({ id: newWebPanelId(next), name: check.name, url: check.url });
      }
      setWebPanels(next);
    },
  },
  "appearance.showComputers": {
    read: async () => { const state = await ogb()?.rail?.state?.(); return state?.available ? !state.hidden : undefined; },
    write: (on) => ogb()?.rail?.setHidden?.(!on),
  },
  "appearance.windowFrame": { read: async () => (await ogb()?.windowFrame?.state())?.on, write: (on) => ogb()?.windowFrame?.set(on) },
  "appearance.sidebarColor": {
    read: async () => {
      const workspaces = ogb()?.remoteClient?.active ? undefined : ogb()?.workspaces;
      const look = await workspaces?.look?.();
      return look?.change ? look.swatch ?? "none" : undefined;
    },
    write: (swatch) => choosePlaceColor(swatch === "none" ? null : swatch),
  },
  "general.followUp": { read: () => readFollowUpDefault(), write: (choice) => setFollowUpDefault(choice) },
  "general.finishedNotifications": {
    read: () => finishedNotificationsEnabled(),
    // As the row does: turning it on asks the system for permission first.
    write: async (on) => { if (!on) return setFinishedNotifications(false); if ((await requestNotificationPermission()) === "granted") setFinishedNotifications(true); },
  },
  "general.notificationFeed": { read: () => notificationFeedEnabled(), write: (on) => setNotificationFeed(on) },
  "general.analytics": { read: () => analyticsEnabled(), write: (on) => setAnalyticsEnabled(on) },
  "general.openAtLogin": { read: async () => { const state = await ogb()?.openAtLogin?.state(); return state?.available ? state.on : undefined; }, write: (on) => ogb()?.openAtLogin?.set(on) },
  "general.talkShortcut": {
    read: async () => { const state = await ogb()?.talkShortcut?.state(); return state?.available ? { enabled: state.enabled, key: state.key } : undefined; },
    write: (change) => ogb()?.talkShortcut?.set(change),
  },
  "account.productEmails": {
    read: async () => { const state = await ogb()?.updatesConsent?.state(); return state?.available ? state.status === "opted_in" : undefined; },
    write: (on) => ogb()?.updatesConsent?.choose({ status: on ? "opted_in" : "withdrawn" }),
  },
  "remote.wifi": route("wifi"),
  "remote.relay": route("relay"),
  "remote.tailscale": route("tailscale"),
  "remote.keepAwake": { read: async () => (await companion()?.state())?.keepAwake, write: (on) => companion()?.keepAwake(on) },
};

export function applyWindowPref(frame: WindowPrefFrame): void {
  const parsed = WINDOW_PREFS[frame.id]?.safeParse(frame.value);
  if (!parsed?.success) return;
  void Promise.resolve((PREFS[frame.id] as Pref<WindowPrefId>).write(parsed.data as never)).catch(() => undefined).finally(reportWindowPrefs);
}

export async function windowPrefValues(): Promise<Partial<Record<WindowPrefId, unknown>>> {
  const ids = Object.keys(PREFS) as WindowPrefId[];
  const values = await Promise.all(ids.map((id) => Promise.resolve().then(() => PREFS[id].read()).catch(() => undefined)));
  return Object.fromEntries(ids.flatMap((id, index) => (values[index] === undefined ? [] : [[id, values[index]]])));
}

let report: ReturnType<typeof setTimeout> | null = null;
/** Tells the server the window's values, once the burst of setters at start-up has settled. */
export function reportWindowPrefs(): void {
  if (typeof fetch !== "function" || typeof window === "undefined") return;
  if (report) clearTimeout(report);
  report = setTimeout(() => {
    report = null;
    void windowPrefValues()
      .then((values) => fetch("/api/window-prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values }) }))
      .catch(() => undefined);
  }, 200);
}

onWindowPrefChanged(reportWindowPrefs);
