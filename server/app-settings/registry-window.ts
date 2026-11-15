// More preferences the app window keeps, or reaches through the desktop app's bridge, each applied with Undo on a card
// saying what it does. A window that can't apply one (a browser has no desktop bridge) refuses it.
import { PLACE_SWATCHES, TALK_KEYS } from "../../shared/app-settings.ts";
import { personOnly, type SettingEntry, type WindowPref } from "./registry.ts";

const turn = (on: boolean, yes: string, no: string) => (on ? yes : no);

export function windowEntries(windowPref: WindowPref): SettingEntry[] {
  const flag = (id: Parameters<WindowPref>[0], label: string, help: string, where: Parameters<WindowPref>[3], synonyms: string[], yes: string, no: string) =>
    windowPref(id, label, help, where, synonyms, "true or false", { says: (on: boolean) => turn(on, yes, no) });
  /** A way in to this computer: a bot may turn it on, but turning it off can cut off the device the person is using now. */
  const wayIn = (id: Parameters<WindowPref>[0], label: string, help: string, synonyms: string[], yes: string) =>
    windowPref(id, label, help, "Settings → Phone & devices", synonyms, "true (turning it off is done by the person, in Settings)",
      { says: () => yes, refusal: (on: boolean) => (on ? null : personOnly(`Turning off ${label}`, "Settings → Phone & devices")) });
  return [
    flag("appearance.userBubbles", "Coloured messages", "Your own messages take the bot's colour.", "Settings → Appearance", ["bubbles", "message color", "my messages"],
      "Colour your messages with each bot's colour", "Show your messages in plain grey"),
    flag("appearance.runCard", "This run card", "Show the card that follows a bot's run while it works.", "Settings → Appearance", ["this run", "run card", "progress"],
      "Show the card that follows each run", "Hide the card that follows each run"),
    flag("appearance.showThreads", "Threads in the sidebar", "List each bot's conversations under it in the sidebar.", "Settings → Appearance", ["threads", "conversations", "sidebar"],
      "List each bot's threads in the sidebar", "Hide threads from the sidebar"),
    windowPref("appearance.toolsLayout", "Sidebar tools layout", "How the sidebar shows its tools: rows, or a toolbar of icons.", "Settings → Appearance", ["tools layout", "toolbar", "rows"], "rows or toolbar",
      { says: (layout: "rows" | "toolbar") => (layout === "rows" ? "Show the sidebar's tools as rows" : "Show the sidebar's tools as a toolbar of icons") }),
    flag("appearance.pinnedCircles", "Pinned bots as circles", "Pinned bots show as a row of circles at the top of the sidebar.", "Settings → Appearance", ["pinned", "circles", "pins"],
      "Show pinned bots as circles", "Show pinned bots as rows"),
    flag("appearance.universalPins", "Universal pins", "Pinned bots stay pinned in every place on the rail.", "Settings → Appearance", ["universal pins", "pins everywhere"],
      "Keep pinned bots pinned in every place", "Pin bots in each place on its own"),
    windowPref("appearance.pinnedPages", "Pinned pages", "Web pages pinned beside the chat. Send the full list; chat pages pinned from a conversation stay.", "Settings → Appearance",
      ["pinned panels", "pinned pages", "web panel", "side page"], 'a list of up to 6 {"name","url"} with http(s) addresses; an empty list unpins every web page',
      { says: (pages: Array<{ name: string; url: string }>) => (pages.length ? `Pin these pages beside the chat: ${pages.map((page) => `${page.name} (${page.url})`).join(", ")}` : "Unpin every web page beside the chat") }),
    flag("appearance.showComputers", "Show your computers", "The rail of places down the side of the window (desktop app).", "Settings → Appearance", ["rail", "show your computers", "places"],
      "Show the rail of your computers and Clouds", "Hide the rail of your computers and Clouds"),
    flag("appearance.windowFrame", "Window frame", "Draw the system's own title bar around the window (desktop app; on Windows after a restart).", "Settings → Appearance", ["window frame", "title bar"],
      "Draw the system title bar around the window", "Draw the window without the system title bar"),
    windowPref("appearance.sidebarColor", "Sidebar colour", "This place's colour, tinting its sidebar and its circle on the rail (desktop app).", "Settings → Overview", ["sidebar color", "sidebar colour", "tint", "cloud color", "place color"],
      `${PLACE_SWATCHES.join(", ")} or none`, { says: (swatch: string) => (swatch === "none" ? "Take the colour off this place's sidebar" : `Tint this place's sidebar ${swatch}`) }),
    windowPref("general.followUp", "Follow-up while a bot works", "What sending does while a bot is busy: steer its current run, or queue the message.", "Settings → General", ["follow up", "steer", "queue"], "steer or queue",
      { says: (choice: "steer" | "queue") => (choice === "steer" ? "Send follow-ups into the bot's current run" : "Queue follow-ups until the bot's run ends") }),
    flag("general.finishedNotifications", "Notifications on this device", "A system notification when a bot finishes or needs you; turning it on asks the system first.", "Settings → General", ["notify", "system notifications", "desktop notifications"],
      "Show a system notification when a bot finishes or needs you", "Stop system notifications from bots"),
    flag("general.notificationFeed", "Notification feed", "Keep a feed of what bots did in the notifications panel.", "Settings → General", ["feed", "notification feed", "inbox"],
      "Keep a feed of bot updates", "Turn off the feed of bot updates"),
    flag("general.analytics", "Usage analytics", "Send anonymous usage data to MausBot (PostHog) to improve the app.", "Settings → General", ["analytics", "telemetry", "privacy", "tracking"],
      "Send anonymous usage data from this app to MausBot's analytics (PostHog), off this computer", "Stop sending usage analytics"),
    flag("general.openAtLogin", "Open at login", "Start MausBot when you log in to this computer (desktop app).", "Settings → General", ["startup", "launch", "login", "open at login"],
      "Open MausBot when you log in", "Don't open MausBot at login"),
    windowPref("general.talkShortcut", "Talk shortcut", "A key held anywhere on this Mac to talk to MausBot (desktop app).", "Settings → General", ["talk", "voice", "dictation", "microphone", "hotkey"],
      `{"enabled":true|false,"key":${TALK_KEYS.map((key) => `"${key}"`).join(" | ")}}`, {
        says: ({ enabled, key }: { enabled: boolean; key: string }) => (enabled ? `Hold ${key.replaceAll("-", "+")} anywhere to talk to MausBot` : "Turn off the talk shortcut"),
      }),
    flag("account.productEmails", "Product update emails", "MausBot emails you product updates.", "Settings → Your account", ["emails", "newsletter", "product updates", "email updates"],
      "Get MausBot product update emails (your email address is sent to MausBot)", "Stop MausBot product update emails"),
    wayIn("remote.wifi", "Same Wi-Fi", "Paired phones reach this computer on the same Wi-Fi network.", ["wifi", "wi-fi", "lan", "local network", "remote access"],
      "Let your paired phones reach this computer on the same Wi-Fi"),
    wayIn("remote.relay", "Reach from anywhere", "Paired phones reach this computer from anywhere through MausBot's relay (needs a MausBot sign-in).", ["relay", "anywhere", "away", "remote access"],
      "Let your paired phones reach this computer from anywhere, through MausBot's relay"),
    wayIn("remote.tailscale", "Tailscale", "Paired devices reach this computer over your Tailscale network (Tailscale must be installed and signed in).", ["tailscale", "tailnet", "remote access"],
      "Let your devices reach this computer over Tailscale"),
    flag("remote.keepAwake", "Keep awake", "Keep this computer awake while a way in is on, so paired phones can reach it.", "Settings → Phone & devices", ["sleep", "awake", "overnight"],
      "Keep this computer awake so paired phones can reach it", "Let this computer sleep"),
  ];
}
