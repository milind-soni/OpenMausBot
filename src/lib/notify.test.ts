import { afterEach, describe, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({ enabled: true, finished: true }));
vi.mock("./notification-preferences", () => ({
  notificationSoundsEnabled: () => sounds.enabled,
  finishedNotificationsEnabled: () => sounds.finished,
}));

import { setLocale } from "./i18n";
import {
  buildNotificationOptions,
  requestNotificationPermission,
  showNotification,
  type NotifyFrame,
} from "./notify";

const frame: NotifyFrame = {
  kind: "done",
  botId: "bot-1",
  botName: "Maus",
  threadId: "thread-1",
  title: "Maus finished",
  body: "All done",
};

function installNotification(permission: NotificationPermission, focused = false) {
  const notices: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null }> = [];
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    constructor(public title: string, public options?: NotificationOptions) {
      notices.push(this);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("document", { hasFocus: () => focused });
  vi.stubGlobal("window", { focus: vi.fn() });
  return { notices, requestPermission };
}

afterEach(() => {
  vi.unstubAllGlobals();
  sounds.enabled = true;
  sounds.finished = true;
});

describe("desktop notifications", () => {
  it("does not request permission from a background notification frame", () => {
    const { notices, requestPermission } = installNotification("default");
    showNotification(frame, vi.fn());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);
  });

  it("requests permission through the explicit settings action", async () => {
    const { requestPermission } = installNotification("default");
    await requestNotificationPermission();
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("contains rejected and synchronous permission failures so Settings can retry", async () => {
    const { requestPermission } = installNotification("default");
    requestPermission.mockRejectedValueOnce(new Error("blocked"));
    await expect(requestNotificationPermission()).resolves.toBe("default");
    requestPermission.mockImplementationOnce(() => { throw new Error("unavailable"); });
    await expect(requestNotificationPermission()).resolves.toBe("default");
    await expect(requestNotificationPermission()).resolves.toBe("granted");
  });

  it("reports a permission already decided without asking again", async () => {
    const { requestPermission } = installNotification("granted");
    await expect(requestNotificationPermission()).resolves.toBe("granted");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("this device's switch mutes finished-work notices, never approval, sign-in or spend ones", () => {
    const { notices } = installNotification("granted");
    sounds.finished = false;
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(0);
    showNotification({ ...frame, kind: "approval" }, vi.fn());
    showNotification({ ...frame, kind: "sign-in" }, vi.fn());
    showNotification({ ...frame, kind: "spend" }, vi.fn());
    expect(notices).toHaveLength(3);
  });

  it("shows a notification after permission is granted", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: frame.title, options: { body: frame.body, tag: `openmausbot:${frame.botId}` } });
  });

  it("stays quiet only when the exact target thread is already visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, frame.threadId);

    expect(notices).toHaveLength(0);
  });

  it("shows a spend notice even over the thread it points at, in its own stack", () => {
    const { notices } = installNotification("granted", true);

    showNotification({ ...frame, kind: "spend", title: "Monthly spend limit reached" }, vi.fn(), "https://avatar.test/a.png", frame.threadId);

    expect(notices).toHaveLength(1);
    expect(notices[0]!.options).toMatchObject({ tag: "openmausbot:spend", icon: undefined });
  });

  it("shows a stored Markdown body as plain text", () => {
    const { notices } = installNotification("granted");
    showNotification({ ...frame, body: "**Facture reçue** — [voir](https://example.com)" }, vi.fn());
    expect(notices[0]?.options?.body).toBe("Facture reçue — voir");
  });

  it("still alerts a focused app when another task is visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, "another-thread");

    expect(notices).toHaveLength(1);
  });

  it("opens the exact detached task carried by the notification", () => {
    const { notices } = installNotification("granted");
    const onOpen = vi.fn();

    showNotification({ ...frame, threadId: "detached-routine-thread" }, onOpen);
    notices[0]!.onclick?.();

    expect(window.focus).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith({
      botId: frame.botId,
      threadId: "detached-routine-thread",
    });
  });

  it("groups under the bot, not the thread", () => {
    const { notices } = installNotification("granted");

    showNotification(frame, vi.fn());
    showNotification(
      { ...frame, threadId: "thread-2", body: "Second task done" },
      vi.fn(),
    );

    expect(notices[0]?.options?.tag).toBe(`openmausbot:${frame.botId}`);
    expect(notices[1]?.options?.tag).toBe(`openmausbot:${frame.botId}`);
    showNotification({ ...frame, botId: "bot-2" }, vi.fn());
    expect(notices[2]?.options?.tag).toBe(`openmausbot:bot-2`);
  });

  it("carries the bot's avatar when its profile has one", () => {
    const { notices } = installNotification("granted");
    const avatarUrl = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png";

    showNotification(frame, vi.fn(), avatarUrl);
    expect(notices[0]?.options?.icon).toBe(avatarUrl);

    showNotification(frame, vi.fn(), null);
    expect(notices[1]?.options?.icon).toBeUndefined();
  });
});

describe("on the desktop app, where main shows the banner so its click outlives the page", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  function installBridge(answer: () => Promise<boolean>) {
    const installed = installNotification("granted");
    const show = vi.fn(answer);
    vi.stubGlobal("window", { focus: vi.fn(), ogb: { desktopNotifications: { show } } });
    return { ...installed, show };
  }

  it("asks main, with the thread to come back to, and shows no banner of its own", async () => {
    const { notices, show } = installBridge(async () => true);
    showNotification(frame, vi.fn(), "/api/attachments/face.png");
    await flush();
    expect(show).toHaveBeenCalledWith({
      title: frame.title, body: frame.body, tag: "openmausbot:bot-1", silent: false, picture: "/api/attachments/face.png", botId: "bot-1", threadId: "thread-1",
    });
    expect(notices).toHaveLength(0);
  });

  it("hands main the same plain line for an older Markdown body", async () => {
    const { show } = installBridge(async () => true);
    showNotification({ ...frame, body: "**Facture reçue**" }, vi.fn());
    await flush();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ body: "Facture reçue" }));
  });

  it("asks main for nothing without the person's permission or over the thread on screen, as ever", async () => {
    const denied = installBridge(async () => true);
    vi.stubGlobal("Notification", class { static permission = "denied"; });
    showNotification(frame, vi.fn());
    await flush();
    expect(denied.show).not.toHaveBeenCalled();
    const { show } = installBridge(async () => true);
    vi.stubGlobal("document", { hasFocus: () => true });
    showNotification(frame, vi.fn(), undefined, frame.threadId);
    await flush();
    expect(show).not.toHaveBeenCalled();
  });

  it.each([["says no", async () => false], ["fails", async () => { throw new Error("no handler"); }]])("shows its own when main %s, so a banner is never lost", async (_case, answer) => {
    const { notices } = installBridge(answer as () => Promise<boolean>);
    const onOpen = vi.fn();
    showNotification(frame, onOpen);
    await flush();
    expect(notices).toHaveLength(1);
    notices[0]!.onclick!();
    expect(onOpen).toHaveBeenCalledWith({ botId: "bot-1", threadId: "thread-1" });
  });

  it("keeps the page's own banner on an older app, which has no bridge for it", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(1);
  });
});

describe("notification sounds", () => {
  it("lets the platform play its sound by default", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices[0]?.options?.silent).toBeUndefined();
  });

  it("posts silently when sounds are muted on this computer, keeping the banner", () => {
    sounds.enabled = false;
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(1);
    expect(notices[0]?.options).toMatchObject({ body: frame.body, silent: true });
  });
});

describe("buildNotificationOptions", () => {
  it("keys coalescing on botId and omits a missing avatar", () => {
    expect(buildNotificationOptions({ id: "bot-9" })).toEqual({
      tag: "openmausbot:bot-9",
      icon: undefined,
    });
  });
});

describe("notification titles", () => {
  afterEach(() => setLocale("en"));

  it.each(["en", "pt-br"] as const)("displays the server's title unchanged with client language %s", (language) => {
    const { notices } = installNotification("granted");
    setLocale(language);
    for (const title of ["Maus em Launch tem uma pergunta", "Maus in Launch has a question", "Maus in Launch hat eine Frage"]) {
      showNotification({ ...frame, kind: "question", groupId: "g1", title }, vi.fn());
      expect(notices.at(-1)?.title).toBe(title);
    }
  });
});
