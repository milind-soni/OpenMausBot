import { afterEach, expect, it, vi } from "vitest";

vi.mock("./notification-preferences", () => ({ notificationSoundsEnabled: () => true, finishedNotificationsEnabled: () => true }));

import { setNotificationPlace, showNotification, type NotifyFrame } from "./notify";

const frame: NotifyFrame = { kind: "done", botId: "bot-1", botName: "Scout", threadId: "thread-1", title: "Scout finished", body: "All done" };

afterEach(() => { setNotificationPlace(null); vi.unstubAllGlobals(); });

it("on a team's page a notification names the team before the bot; anywhere else it is as before", () => {
  const titles: string[] = [];
  vi.stubGlobal("Notification", class { static permission = "granted"; onclick = null; constructor(title: string) { titles.push(title); } });
  vi.stubGlobal("document", { hasFocus: () => false });
  vi.stubGlobal("window", { focus: vi.fn() });
  showNotification(frame, () => {});
  setNotificationPlace("Acme");
  showNotification(frame, () => {});
  setNotificationPlace(null);
  showNotification(frame, () => {});
  expect(titles).toEqual(["Scout finished", "Acme · Scout finished", "Scout finished"]);
});
