import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  cloudUsageSummary,
  phoneDevicesItem,
  phoneDevicesSubtitle,
  placeMenuItems,
  planUsageSummary,
  profileInitials,
  profileMenuItems,
  resetsIn,
  simpleUpdateTop,
  accountDot,
  accountLabel,
  toolMenuItems,
  type PlanUsageWindows,
  selectPhoneDestination,
  profileLabel,
  updateBusy,
  updateNoteworthy,
  updateLabel,
  updatePhase,
} from "./SidebarProfileMenu";
import { ANDROID_APK_URL, DOCS_URL, FEEDBACK_URL, HELP_CENTER_URL, IOS_APP_STORE_URL, platformLabel } from "@/lib/app-links";
import { profileForSession } from "@/lib/session";
import {
  cloudPhoneDestination,
  connectPhoneEntry,
  phoneDestinations,
  phonePairingSettingsAction,
} from "@/lib/phone-pairing";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { PHONE_APPS, PhoneAppDialog, type PhoneAppConnect } from "./PhoneAppDialog";
import type { UpdaterState } from "@/lib/updater";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";
import { moveMenuItems } from "./AccountMove";
import { moveLine } from "@/lib/cloud-send";
import { InitialsAvatar } from "./Avatar";

const state = (patch: Partial<UpdaterState>): UpdaterState => ({ status: "idle", ...patch }) as UpdaterState;

describe("profileInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(profileInitials({ name: "Milind Soni" })).toBe("MS");
    expect(profileInitials({ name: "Ada Byron Lovelace" })).toBe("AB");
  });

  it("falls back to the email, then to a placeholder", () => {
    expect(profileInitials({ email: "you@x.dev" })).toBe("Y");
    expect(profileInitials({})).toBe("?");
    expect(profileInitials(undefined)).toBe("?");
  });

  it("ignores whitespace-only names", () => {
    expect(profileInitials({ name: "   ", email: "you@x.dev" })).toBe("Y");
  });
});

describe("profileLabel", () => {
  it("prefers the name, then the email, then You", () => {
    expect(profileLabel({ name: "Omkar", email: "o@x.dev" })).toBe("Omkar");
    expect(profileLabel({ email: "o@x.dev" })).toBe("o@x.dev");
    expect(profileLabel(undefined)).toBe("You");
  });
});

describe("the sidebar profile for a signed-in visitor", () => {
  it("uses the fallback while the session identity is still loading", () => {
    const visible = profileForSession(
      { name: "Owner", email: "owner@example.test", avatarUrl: "/owner.png" },
      null,
    );
    expect(profileLabel(visible)).toBe("You");
    expect(profileInitials(visible)).toBe("?");
    expect(visible?.avatarUrl).toBeUndefined();
  });

  it("shows the verified email and initials without the configured owner's name or avatar", () => {
    const visible = profileForSession(
      { name: "Owner", email: "owner@example.test", avatarUrl: "/owner.png" },
      { kind: "session", id: "s", label: "Ada's iPad", email: "ada@example.test", scopes: ["client"], expiresAt: 1 },
    );
    expect(profileLabel(visible)).toBe("ada@example.test");
    expect(profileInitials(visible)).toBe("A");
    expect(visible?.avatarUrl).toBeUndefined();
  });
});

describe("updatePhase", () => {
  it("reports the bridge's own in-flight states", () => {
    expect(updatePhase(state({ status: "checking" }), false)).toBe("checking");
    expect(updatePhase(state({ status: "downloading" }), false)).toBe("downloading");
    expect(updatePhase(state({ status: "preparing" }), false)).toBe("preparing");
    expect(updatePhase(state({ status: "installing" }), false)).toBe("installing");
  });

  it("acknowledges a check that found nothing", () => {
    expect(updatePhase(null, true)).toBe("up-to-date");
    expect(updatePhase(null, false)).toBe("idle");
  });

  it("lets a real status outrank the acknowledgement", () => {
    expect(updatePhase(state({ status: "downloading" }), true)).toBe("downloading");
  });
});

describe("updateLabel", () => {
  it("names the version it is ready to install", () => {
    expect(updateLabel("downloaded", state({ status: "downloaded", version: "0.2.0" }))).toBe(
      "Restart to update to MausBot 0.2.0",
    );
  });

  it("shows progress only once there is a percentage", () => {
    expect(updateLabel("downloading", state({ status: "downloading" }))).toBe("Starting download…");
    expect(updateLabel("downloading", state({ status: "downloading", percent: 41.6 }))).toBe("Downloading… 42%");
  });

  it("distinguishes native preparation from restart readiness", () => {
    expect(updateLabel("preparing", state({ status: "preparing", percent: 100 }))).toBe("Preparing update…");
    expect(updateLabel("installing", state({ status: "installing", message: "Restart is taking longer than expected." })))
      .toBe("Restart is taking longer than expected.");
    expect(updateLabel("downloaded", state({ status: "downloaded", version: "0.2.0", installMode: "handoff" })))
      .toBe("Install MausBot 0.2.0");
    expect(updateLabel("installing", state({ status: "installing", installMode: "handoff" })))
      .toBe("Opening a terminal…");
  });

  it("carries the updater's own message when something failed", () => {
    expect(updateLabel("error", state({ status: "error", message: "Network unreachable" }))).toBe(
      "Network unreachable",
    );
    expect(updateLabel("error", state({ status: "error" }))).toBe("The update didn't finish. Try again.");
  });

  it("points a hand-off at the terminal that finishes it", () => {
    expect(updateLabel("handed-off", state({ status: "handed-off" }))).toBe(
      "Finish the update in your terminal",
    );
  });

  it("defaults to the invitation to check", () => {
    expect(updateLabel("idle", null)).toBe("Check for updates");
    expect(updateLabel("up-to-date", null)).toBe("You're up to date");
  });
});

describe("updateBusy", () => {
  it("blocks clicks while something is in flight", () => {
    expect(updateBusy("checking")).toBe(true);
    expect(updateBusy("downloading")).toBe(true);
    expect(updateBusy("preparing")).toBe(true);
    expect(updateBusy("installing")).toBe(true);
    expect(updateBusy("downloaded")).toBe(false);
    expect(updateBusy("idle")).toBe(false);
  });

  it("blocks the gap between the click and the bridge catching up", () => {
    expect(updateBusy("downloaded", true)).toBe(true);
    expect(updateBusy("error", true)).toBe(true);
  });
});

describe("platformLabel", () => {
  it("names the platforms we ship, and stays quiet otherwise", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("linux")).toBe("Linux");
    expect(platformLabel("freebsd")).toBeNull();
    expect(platformLabel(undefined)).toBeNull();
  });
});

describe("updateNoteworthy", () => {
  it("puts a real update on the profile row", () => {
    expect(updateNoteworthy("downloading")).toBe(true);
    expect(updateNoteworthy("preparing")).toBe(true);
    expect(updateNoteworthy("downloaded")).toBe(true);
    expect(updateNoteworthy("installing")).toBe(true);
    expect(updateNoteworthy("error")).toBe(true);
    expect(updateNoteworthy("handed-off")).toBe(true);
  });

  it("leaves a quiet updater quiet", () => {
    expect(updateNoteworthy("idle")).toBe(false);
    expect(updateNoteworthy("checking")).toBe(false);
    expect(updateNoteworthy("up-to-date")).toBe(false);
  });

  it("shows the click that has not landed yet", () => {
    expect(updateNoteworthy("idle", true)).toBe(true);
  });
});

describe("outward links", () => {
  it("sends Help Center to the docs the website also links to", () => {
    expect(HELP_CENTER_URL).toBe(DOCS_URL);
    expect(DOCS_URL).toBe("https://github.com/milind-soni/OpenMausBot/tree/main/docs");
  });

  it("sends Send Feedback to the Discord community", () => {
    expect(FEEDBACK_URL).toBe("https://discord.gg/9Wb8MEpXRs");
  });
});

describe("the Phone & devices row", () => {
  const sub = (state: Parameters<typeof phoneDevicesSubtitle>[0], place = "This computer") => phoneDevicesSubtitle(state, place);

  it("names the place the phone joins, and how it is doing there", () => {
    expect(sub({ kind: "none" })).toBe("Not set up on This computer");
    expect(sub({ kind: "checking" }, "My Cloud")).toBe("Not set up on My Cloud");
    expect(sub({ kind: "paired", count: 2, connected: false })).toBe("2 paired with This computer");
    expect(sub({ kind: "attention", count: 1 })).toBe("Needs attention on This computer");
  });

  it("says each blocked state in a few words", () => {
    expect(sub({ kind: "managed", organization: "Acme" }, "Acme team")).toBe("Managed by Acme");
    expect(sub({ kind: "chat-only" }, "studio.example.com")).toBe("Chat and approvals only");
    expect(sub({ kind: "portal" }, "studio.example.com")).toBe("Signed in through your organization");
  });

  it("is one row, dotted green while a phone is connected, that opens Phone & devices", () => {
    const open = vi.fn();
    const row = phoneDevicesItem({ kind: "paired", count: 1, connected: true }, "This computer", open);
    expect([row.key, row.label]).toEqual(["phone-devices", "Phone & devices"]);
    expect(row.trailing).toBeTruthy();
    expect(phoneDevicesItem({ kind: "none" }, "This computer", open).trailing).toBeUndefined();
    row.onSelect();
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("choosing where the phone connects", () => {
  const destinations = (account: CloudAccountState | null) => phoneDestinations(connectPhoneEntry("computer", null), cloudPhoneDestination(account));
  const readyCloud: CloudAccountState = { status: "connected", entitlement: { plan: "pro", status: "active", expiresAt: null, version: 1 }, machine: { status: "ready", origin: "https://home-7f3k2.fly.dev" } };
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it("to My Cloud opens the Cloud on its phone pairing, as Use the Cloud on your phone does, sending nothing", async () => {
    const bridge = { connectHomeForPhone: vi.fn().mockResolvedValue({ status: "connected" }) };
    const dispatch = vi.fn();
    selectPhoneDestination(destinations(readyCloud)[0]!, { bridge, dispatch });
    await flush();
    expect(bridge.connectHomeForPhone).toHaveBeenCalledExactlyOnceWith();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("when the Cloud cannot be opened, lands on Settings → MausBot Cloud, which says what to do", async () => {
    const bridge = { connectHomeForPhone: vi.fn().mockRejectedValue(new Error("offline")) };
    const dispatch = vi.fn();
    selectPhoneDestination(destinations(readyCloud)[0]!, { bridge, dispatch });
    await flush();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
  });

  it("to this computer opens this computer's phone pairing and never touches the Cloud", () => {
    const bridge = { connectHomeForPhone: vi.fn() };
    const dispatch = vi.fn();
    selectPhoneDestination(destinations(readyCloud)[1]!, { bridge, dispatch });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(phonePairingSettingsAction());
    expect(bridge.connectHomeForPhone).not.toHaveBeenCalled();
  });
});

describe("Get the phone app", () => {
  it("offers iPhone and Android with the links the website and Cloud page use", () => {
    expect(PHONE_APPS.map((app) => [app.id, app.url])).toEqual([["ios", IOS_APP_STORE_URL], ["android", ANDROID_APK_URL]]);
    expect(IOS_APP_STORE_URL).toBe("https://apps.apple.com/in/app/mausbot/id6803387923");
    expect(ANDROID_APK_URL).toBe("https://github.com/milind-soni/OpenMausBot/releases/download/android-v1.5.0/OpenMausBot.apk");
  });

  const render = (connect?: PhoneAppConnect[]) => {
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
    try {
      return renderToStaticMarkup(createElement(PhoneAppDialog, { open: true, onClose: () => {}, connect }));
    } finally {
      vi.unstubAllGlobals();
    }
  };
  const to = (key: string, subtitle: string): PhoneAppConnect => ({ key, subtitle, onSelect: () => {} });

  it("links each store in words, with no code to scan (the pairing code is the only one), and points on to Connect your phone where this window can pair", () => {
    const html = render([to("here", "to this computer")]);
    expect(html).toContain('data-phone-app="ios"');
    expect(html).toContain('data-phone-app="android"');
    expect(html.match(/<svg/g)).toBeNull();
    expect(html).toMatch(/data-phone-app="ios"[^>]*>App Store</);
    expect(html).toMatch(/data-phone-app="android"[^>]*>Android</);
    expect(html).toContain("Connect your phone");
    expect(html).toContain("to this computer");
    expect(render()).not.toContain("Connect your phone");
    expect(render([])).not.toContain("Connect your phone");
  });

  it("offers every destination the menu does, in the same order", () => {
    const html = render([to("cloud", "to the Cloud (always on)"), to("here", "to this computer")]);
    expect(html.indexOf('data-phone-app-connect="cloud"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-phone-app-connect="cloud"')).toBeLessThan(html.indexOf('data-phone-app-connect="here"'));
  });

  it("is not drawn while closed", () => {
    expect(renderToStaticMarkup(createElement(PhoneAppDialog, { open: false, onClose: () => {} }))).toBe("");
  });
});

describe("profileMenuItems", () => {
  const noop = () => {};
  const build = (patch: Partial<Parameters<typeof profileMenuItems>[0]> = {}) => profileMenuItems({
    phone: { key: "phone-devices", label: "Phone & devices", onSelect: noop },
    update: null,
    header: { name: "Ada Lovelace", line: "Pro · ada@example.com", avatar: null, onOpen: noop },
    plan: { key: "plan", label: "Plan & billing", onSelect: noop },
    onSettings: noop, onShortcuts: noop, onAbout: noop, onHelp: noop, onFeedback: noop,
    ...patch,
  });

  it("starts with your account, then Phone & devices and Settings, then Plan & billing and Help after a divider", () => {
    const items = build();
    expect(items.map((item) => item.key)).toEqual(["account", "phone-devices", "settings", "plan", "support"]);
    expect(items.filter((item) => item.separatorBefore).map((item) => item.key)).toEqual(["phone-devices", "plan"]);
    expect(items.find((item) => item.key === "support")!.submenu!.map((item) => item.key)).toEqual(["help", "shortcuts", "feedback", "about"]);
    expect(items[0]).toMatchObject({ label: "Ada Lovelace", subtitle: "Pro · ada@example.com", large: true, chevron: true });
  });

  it("only offers what this window has: no Phone & devices for a paired client, no Plan & billing without a plan", () => {
    expect(build({ phone: null, plan: null }).map((item) => item.key)).toEqual(["account", "settings", "support"]);
  });

  it("keeps Check for updates in Help in both modes, and raises a ready update to the top", () => {
    const update = { key: "update", label: "Check for updates", onSelect: noop };
    expect(build({ update }).find((item) => item.key === "support")!.submenu!.map((item) => item.key)).toEqual(["help", "shortcuts", "feedback", "update", "about"]);
    const raised = build({ update, updateTop: { label: "Update ready", action: "Restart" } });
    expect(raised[0]!.key).toBe("update");
    expect(raised[0]!.label).toBe("Update ready");
    expect(raised.find((item) => item.key === "support")!.submenu!.map((item) => item.key)).not.toContain("update");
  });

  it("opens Your account from the header, whether signed in or not", () => {
    const onOpen = vi.fn();
    for (const line of ["Pro · ada@example.com", "Not signed in"]) build({ header: { name: "Ada", line, avatar: null, onOpen } })[0]!.onSelect();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("ends with the other accounts and Sign out, under a divider", () => {
    const accounts = [{ key: "accounts-sign-out", label: "Sign out", onSelect: noop }];
    const items = build({ accounts });
    expect(items.at(-1)).toMatchObject({ key: "accounts-sign-out", separatorBefore: true });
  });
});

describe("Simple mode's account menu", () => {
  const noop = () => {};
  const tools = toolMenuItems({ activeView: "routines", automationsNeedYou: true, onAutomations: noop, onTeamMap: noop });
  const place = (patch: Partial<Parameters<typeof placeMenuItems>[0]> = {}) => ({
    bridge: { state: async () => ({ local: true, name: "This computer" }), menu: async () => {} },
    current: { local: true, name: "This computer" },
    cloudHome: false,
    onLine: "",
    openMenu: vi.fn(),
    switchable: true,
    ...patch,
  });
  const build = (patch: Partial<Parameters<typeof profileMenuItems>[0]> = {}) => profileMenuItems({
    phone: { key: "phone-devices", label: "Phone & devices", onSelect: noop },
    update: { key: "update", label: "Check for updates", onSelect: noop },
    header: { name: "Ada", line: "Not signed in", avatar: null, onOpen: noop },
    plan: { key: "plan", label: "Plan & billing", onSelect: noop },
    simple: { tools },
    onSettings: noop, onShortcuts: noop, onAbout: noop, onHelp: noop, onFeedback: noop,
    ...patch,
  });
  const groups = (items: SidebarMenuItem[]) => items.reduce<string[][]>((all, item) => {
    if (item.separatorBefore || all.length === 0) all.push([]);
    all[all.length - 1]!.push(item.key);
    return all;
  }, []);

  it("is the same menu as Advanced, with Automations and Team map in their own group between Settings and Plan & billing", () => {
    const items = build();
    expect(groups(items)).toEqual([
      ["account"],
      ["phone-devices", "settings"],
      ["automations", "team-map"],
      ["plan", "support"],
    ]);
    expect(items.find((item) => item.key === "support")!.submenu!.map((item) => item.key)).toEqual(["help", "shortcuts", "feedback", "update", "about"]);
  });

  it("raises an update that is ready or failed to its own top row with a pill, and keeps it out of support", () => {
    const update = { key: "update", label: "Restart to update to MausBot 0.2.0", subtitle: "notes", attention: true, onSelect: noop };
    const items = build({ update, updateTop: { label: "Update ready", action: "Restart" } });
    expect(groups(items)[0]).toEqual(["update"]);
    expect(items[0]).toMatchObject({ label: "Update ready", subtitle: undefined, attention: false });
    expect(renderToStaticMarkup(createElement("div", null, items[0]!.trailing))).toContain(">Restart</span>");
    expect(items[1]!.separatorBefore).toBe(true);
    expect(items.find((item) => item.key === "support")!.submenu!.map((item) => item.key)).not.toContain("update");
  });

  it("raises a downloaded or failed app update and a newer server, and nothing else", () => {
    expect(simpleUpdateTop({ source: "desktop", phase: "downloaded" })).toEqual({ label: "Update ready", action: "Restart" });
    expect(simpleUpdateTop({ source: "desktop", phase: "downloaded", installMode: "handoff" })).toEqual({ label: "Update ready", action: "Install" });
    expect(simpleUpdateTop({ source: "desktop", phase: "error" })).toEqual({ label: "Update failed", action: "Retry" });
    expect(simpleUpdateTop({ source: "server", phase: "available" })).toEqual({ label: "Update ready", action: "Install" });
    expect(simpleUpdateTop({ source: "server", phase: "reload" })).toEqual({ label: "Update ready", action: "Restart" });
    for (const phase of ["idle", "checking", "downloading", "up-to-date"] as const) expect(simpleUpdateTop({ source: "desktop", phase })).toBeNull();
    expect(simpleUpdateTop({ source: "server", phase: "error" })).toBeNull();
    expect(simpleUpdateTop(null)).toBeNull();
  });

  it("adds Files once My Cloud's files are ready and Archived bots while there are any, after Team map", () => {
    const open = vi.fn();
    const items = toolMenuItems({ activeView: "files", automationsNeedYou: false, onAutomations: noop, onTeamMap: noop, onFiles: noop, archived: { count: 3, open } });
    expect(items.map((item) => [item.key, item.active, item.value])).toEqual([["automations", false, undefined], ["team-map", false, undefined], ["files", true, undefined], ["archived", undefined, "3"]]);
    items[3]!.onSelect();
    expect(open).toHaveBeenCalledOnce();
    expect(toolMenuItems({ activeView: "chat", automationsNeedYou: false, onAutomations: noop, onTeamMap: noop, archived: { count: 0, open } }).map((item) => item.key)).toEqual(["automations", "team-map"]);
  });

  it("names the account button after the person and whatever its dot is raised for", () => {
    expect(accountLabel("You", { automationsNeedYou: false, update: null })).toBe("You");
    expect(accountLabel("Ada", { automationsNeedYou: true, update: "Update failed. Try again." })).toBe("Ada · Automations need you · Update failed. Try again.");
  });

  it("adds the move to My Cloud: a short warning once failing, shared with automations, and a quiet segment on its way", () => {
    expect(accountLabel("Omkar", { automationsNeedYou: false, update: null, move: "failed" })).toBe("Omkar · My Cloud move needs you");
    expect(accountLabel("Omkar", { automationsNeedYou: true, update: null, move: "failed" })).toBe("Omkar · My Cloud move and automations need you");
    expect(accountLabel("Omkar", { automationsNeedYou: true, update: "Update ready", move: "failed" })).toBe("Omkar · My Cloud move and automations need you · Update ready");
    expect(accountLabel("Omkar", { automationsNeedYou: false, update: null, move: "sending" })).toBe("Omkar · Moving to My Cloud…");
    expect(accountLabel("Omkar", { automationsNeedYou: true, update: null, move: "sending" })).toBe("Omkar · Automations need you · Moving to My Cloud…");
    expect(accountLabel("Omkar", { automationsNeedYou: false, update: null, move: "done" })).toBe("Omkar");
    expect(accountLabel("Omkar", { automationsNeedYou: true, update: null, move: "done" })).toBe("Omkar · Automations need you");
    expect(accountLabel("Omkar", { automationsNeedYou: false, update: null, move: null })).toBe("Omkar");
  });

  it("raises the avatar's dot red for a failing move like automations, and none on its way or once done", () => {
    expect(accountDot({ automationsNeedYou: false, update: null, move: "failed" })).toBe("danger");
    expect(accountDot({ automationsNeedYou: true, update: null, move: "failed" })).toBe("danger");
    expect(accountDot({ automationsNeedYou: false, update: "news", move: "failed" })).toBe("danger");
    expect(accountDot({ automationsNeedYou: false, update: null, move: "sending" })).toBeNull();
    expect(accountDot({ automationsNeedYou: false, update: null, move: "done" })).toBeNull();
    expect(accountDot({ automationsNeedYou: false, update: "news", move: "done" })).toBe("accent");
    expect(accountDot({ automationsNeedYou: false, update: null, move: null })).toBeNull();
    expect(accountDot({ automationsNeedYou: true, update: null, move: null })).toBe("danger");
    expect(accountDot({ automationsNeedYou: false, update: "failed", move: null })).toBe("danger");
    expect(accountDot({ automationsNeedYou: false, update: "news", move: "sending" })).toBe("accent");
  });

  it("puts the move's row first, in its own group, above a raised update", () => {
    const move = [{ key: "cloud-move", label: "Try My Cloud move again", title: "My Cloud did not answer.", onSelect: noop }];
    const update = { key: "update", label: "OpenMausBot 0.2.0 ready, restart", onSelect: noop };
    expect(groups(build({ move }))).toEqual([
      ["cloud-move"],
      ["account"],
      ["phone-devices", "settings"],
      ["automations", "team-map"],
      ["plan", "support"],
    ]);
    expect(groups(build({ move, update, updateTop: { label: "Update ready", action: "Restart" } })).slice(0, 2)).toEqual([["cloud-move"], ["update"]]);
    expect(groups(build({ move: [] }))[0]).toEqual(["account"]);
  });

  it("gives a moving move one plain row, and a failing one the reason written under its Try again", () => {
    const shape = (item: SidebarMenuItem) => ({ lines: [item.subtitle, item.note].filter(Boolean).length, wrap: item.wrap === true, icon: Boolean(item.icon) });
    const failing = moveMenuItems(moveLine({ phase: "copy", failing: { error: "Some of this computer's things did not reach My Cloud." } }, "local"), { onOpen: noop, onRetry: noop, onClose: noop });
    const moving = moveMenuItems(moveLine({ phase: "copy", chats: { done: 34, total: 120 } }, "local"), { onOpen: noop, onRetry: noop, onClose: noop });
    const items = build({ move: moving });
    expect(groups(items)[0]).toEqual(["cloud-move"]);
    expect(shape(items[0]!)).toEqual({ lines: 0, wrap: false, icon: true });
    const failed = build({ move: failing });
    expect(groups(failed)[0]).toEqual(["cloud-move"]);
    expect(shape(failed[0]!)).toEqual({ lines: 1, wrap: true, icon: true });
    expect(failed[0]!.note).toBe("Some of this computer's things did not reach My Cloud.");
  });

  it("puts the move's row first in Advanced's account menu too, under its own divider", () => {
    const move = [{ key: "cloud-move", label: "Moving to My Cloud…", title: "Moving your bots to My Cloud… 34 of 120 chats", onSelect: noop }];
    expect(groups(build({ simple: undefined, move }))).toEqual([["cloud-move"], ["account"], ["phone-devices", "settings"], ["plan", "support"]]);
    expect(groups(build({ simple: undefined }))).toEqual([["account"], ["phone-devices", "settings"], ["plan", "support"]]);
  });

  it("draws a person instead of a question mark for someone with no name, at the trigger's own size", () => {
    const glyph = createElement("svg", { "data-glyph": "" });
    const nameless = renderToStaticMarkup(createElement(InitialsAvatar, { initials: profileInitials({}), size: 36, fallback: glyph, fontSize: 14 }));
    expect(nameless).toContain("data-glyph");
    expect(nameless).not.toContain("?");
    expect(nameless).toContain("font-size:14px");
    expect(renderToStaticMarkup(createElement(InitialsAvatar, { initials: "AL", size: 50 }))).toContain("font-size:19px");
  });

  it("marks Automations open and needing attention, and Team map plain", () => {
    expect(tools.map((item) => [item.key, item.active, item.attention])).toEqual([["automations", true, true], ["team-map", false, undefined]]);
  });

  it("ticks the current place and switches through the same native menu as the server pill", () => {
    const here = place();
    const items = placeMenuItems(here, { owner: null, onCloudSettings: noop });
    expect(items.map((item) => [item.key, item.label])).toEqual([["place", "This computer"], ["switch-place", "Switch to…"]]);
    expect(items[0]!.trailing).toBeTruthy();
    items[0]!.onSelect();
    items[1]!.onSelect();
    expect(here.openMenu).toHaveBeenCalledTimes(2);
  });

  it("names My Cloud and opens its settings when it is the window's only place, and offers nothing without either", () => {
    const onCloudSettings = vi.fn();
    const home = placeMenuItems(place({ switchable: false, cloudHome: true, onLine: "always on" }), { owner: "ada@example.test", onCloudSettings });
    expect(home.map((item) => [item.label, item.subtitle])).toEqual([["My Cloud", "always on · ada@example.test’s Cloud"]]);
    home[0]!.onSelect();
    expect(onCloudSettings).toHaveBeenCalledOnce();
    expect(placeMenuItems(place({ bridge: undefined, switchable: false }), { owner: null, onCloudSettings })).toEqual([]);
  });

  it("names a team's Cloud by the team", () => {
    const team = placeMenuItems(place({ switchable: false, cloudHome: true, onLine: "" }), { owner: null, name: "Acme Labs", onCloudSettings: noop });
    expect(team.map((item) => item.label)).toEqual(["Acme Labs"]);
  });
});

describe("the usage meta", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const window = (usedPercent: number | null, resetsAt: string | null = null) => ({ available: usedPercent !== null, usedPercent, resetsAt });
  const provider = (patch: Partial<PlanUsageWindows["providers"][number]> = {}) => ({ ok: true, plan: null, weekly: window(null), fiveHour: window(null), ...patch });

  it("reads the tightest weekly window, then the 5-hour one, with when it resets", () => {
    const report = { providers: [provider({ weekly: window(12, "2026-10-30T12:00:00Z") }), provider({ weekly: window(31.6, "2026-10-28T12:00:00Z") }), provider({ ok: false, weekly: window(90) })] };
    expect(planUsageSummary(report, now)).toEqual({ value: "32% used", weekly: true, resets: "Resets tomorrow" });
    expect(planUsageSummary({ providers: [provider({ fiveHour: window(40, "2026-10-27T15:00:00Z") })] }, now)).toEqual({ value: "40% used", weekly: false, resets: "Resets in 3 hours" });
  });

  it("falls back to a plan's monthly budget when it has no rolling window", () => {
    const report = { providers: [provider({ extra: [{ label: "Monthly spend", usedPercent: 9.3 }, { label: "Other", usedPercent: 80 }] })] };
    expect(planUsageSummary(report, now)).toEqual({ value: "9% used" });
    expect(planUsageSummary({ providers: [provider({ extra: [{ label: "Other", usedPercent: 80 }] })] }, now)).toBeNull();
  });

  it("shows nothing without a percent, not even the plan's name", () => {
    expect(planUsageSummary({ providers: [provider({ plan: "Max" })] }, now)).toBeNull();
    expect(planUsageSummary({ providers: [provider()] }, now)).toBeNull();
    expect(planUsageSummary(null, now)).toBeNull();
  });

  it("says when a reset is days away, and nothing once it has passed", () => {
    expect(resetsIn(now + 3 * 86_400_000, now)).toBe("Resets in 3 days");
    expect(resetsIn(now - 1, now)).toBeUndefined();
    expect(resetsIn(null, now)).toBeUndefined();
  });

  it("reads a paid Cloud's tightest meter, and nothing without one", () => {
    const usage = { tier: "pro", resetsAt: Date.parse("2026-11-01T00:00:00Z"), meters: [{ kind: "voice", used: 30, max: 100 }, { kind: "decisions", used: 85, max: 100 }] };
    expect(cloudUsageSummary({ status: "paid", tier: "pro", usage } as never)).toMatchObject({ value: "85% used" });
    expect(cloudUsageSummary({ status: "paid", tier: "pro" } as never)).toBeNull();
    expect(cloudUsageSummary({ status: "none" } as never)).toBeNull();
  });
});
