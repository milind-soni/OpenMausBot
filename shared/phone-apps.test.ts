import { describe, expect, it } from "vitest";
import { isOutboundTool, isReadOnlyTool } from "./outbound.ts";
import { ALL_PHONE_APPS, PHONE_CAPABILITIES, PHONE_TOOL_NAMES, isPhoneWrite, normalizePhoneApps, phoneToolCapability, phoneToolSends } from "./phone-apps.ts";

describe("phone tool vocabulary", () => {
  it("maps every tool to one capability", () => {
    for (const name of PHONE_TOOL_NAMES) expect(PHONE_CAPABILITIES).toContain(phoneToolCapability(name));
    expect(phoneToolCapability("PHONE_SEND_WHATSAPP")).toBe("messages");
    expect(phoneToolCapability("PHONE_FIND_PLACES_NEARBY")).toBe("location");
  });
  it("splits reads from writes by verb", () => {
    expect(PHONE_TOOL_NAMES.filter((n) => !isPhoneWrite(n))).toEqual(["PHONE_LIST_EVENTS", "PHONE_GET_EVENT", "PHONE_FIND_FREE_TIME", "PHONE_LIST_REMINDERS", "PHONE_SEARCH_CONTACTS", "PHONE_GET_CONTACT", "PHONE_GET_LOCATION", "PHONE_FIND_PLACES_NEARBY", "PHONE_LIST_HOME"]);
  });
  it("is classed by the existing outbound rules with no special case", () => {
    expect(isOutboundTool("PHONE_SEND_MESSAGE")).toBe(true);
    expect(isOutboundTool("mcp__device__PHONE_SEND_WHATSAPP")).toBe(true);
    expect(isOutboundTool("PHONE_CREATE_EVENT")).toBe(false);
    expect(isReadOnlyTool("PHONE_LIST_EVENTS")).toBe(true);
    expect(phoneToolSends("PHONE_SEND_MESSAGE")).toBe(true);
    expect(phoneToolSends("PHONE_CREATE_REMINDER")).toBe(false);
  });
  it("normalizes grants", () => {
    expect(normalizePhoneApps({ calendar: "read", messages: "write" })).toEqual({ calendar: "read", messages: "write" });
    expect(normalizePhoneApps({})).toEqual({});
    expect(normalizePhoneApps({ calendar: "full" })).toBeNull();
    expect(normalizePhoneApps({ health: "read" })).toBeNull();
    expect(normalizePhoneApps("read")).toBeNull();
    expect(Object.keys(ALL_PHONE_APPS)).toEqual([...PHONE_CAPABILITIES]);
  });
});
