import { describe, expect, it } from "vitest";
import { phoneBackStep, phoneBackSteps, type PhoneBackPlace } from "./phone-back";

const CHAT: PhoneBackPlace = { calendar: false, drawerOpen: false, panelOpen: false, preview: false, appsPage: false, drawerSteps: 0 };

describe("the phone's back button", () => {
  it("has nothing to step back from on the first chat, so back leaves the app", () => {
    expect(phoneBackSteps(CHAT)).toBe(0);
  });

  it("goes from the automations calendar back to the list first, even when the hidden bot list has steps", () => {
    const calendar = { ...CHAT, calendar: true, drawerSteps: 1 };
    expect(phoneBackSteps(calendar)).toBe(2);
    expect(phoneBackStep(calendar)).toBe("calendar");
    expect(phoneBackStep({ ...calendar, calendar: false })).toBe("drawer");
  });

  it("closes the apps page reached from the list as the list comes back", () => {
    const apps = { ...CHAT, appsPage: true, drawerSteps: 1 };
    expect(phoneBackSteps(apps)).toBe(1);
    expect(phoneBackStep(apps)).toBe("apps-page");
    expect(phoneBackStep({ ...apps, drawerOpen: true }), "the list open over it closes first").toBe("drawer");
  });

  it("closes the open list before a side panel, and a side panel before going back to the list", () => {
    expect(phoneBackStep({ ...CHAT, drawerOpen: true, panelOpen: true, drawerSteps: 1 })).toBe("drawer");
    expect(phoneBackStep({ ...CHAT, panelOpen: true, drawerSteps: 1 })).toBe("panels");
    expect(phoneBackSteps({ ...CHAT, panelOpen: true, drawerSteps: 1 })).toBe(2);
  });

  it("closes a file or app preview over the chat like a side panel", () => {
    const preview = { ...CHAT, preview: true, drawerSteps: 1 };
    expect(phoneBackSteps(preview)).toBe(2);
    expect(phoneBackStep(preview)).toBe("panels");
    expect(phoneBackSteps({ ...preview, panelOpen: true }), "one step closes both").toBe(2);
  });
});
