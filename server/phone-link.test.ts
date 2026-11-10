import { afterEach, describe, expect, it } from "vitest";

import { applyPhoneLinkMessage, phoneLinkPart, phoneLinkPrompt } from "./phone-link.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

const told = (olderPhoneApps: unknown) => applyPhoneLinkMessage({ type: "openmausbot:phone-link", olderPhoneApps });
afterEach(() => { told(0); });

describe("phoneLinkPrompt", () => {
  it("is empty unless this computer's link ended with a phone on an older app, so no other prompt pays for it", () => {
    expect(phoneLinkPrompt(0)).toBe("");
    expect(phoneLinkPart()).toEqual({ id: "phone-link", label: "Phone link", text: "" });
    const built = buildSystemPrompt("You are Ada.", "", [phoneLinkPart()]);
    expect(built.sections.map((section) => section.id)).not.toContain("phone-link");
    expect(built.text).not.toContain("Phone link");
  });

  it("gives the cause, the fix and what won't help, for the phones it is true of", () => {
    const one = phoneLinkPrompt(1);
    expect(one).toContain("this computer's secure link for older MausBot phone apps has ended, and 1 phone paired with this computer has an older app");
    expect(one).toContain("connects on the same Wi-Fi only");
    expect(one).toContain("\"No route to your computer\"");
    expect(one).toContain("\"Anywhere, through MausBot\" doesn't work");
    expect(one).toContain("update the MausBot app on that phone, then pair it again in Settings → Phone & devices");
    expect(one).toContain("Turning routes off and on, reconnecting, restarting the app or checking a VPN won't help");
    expect(phoneLinkPrompt(2)).toContain("2 phones paired with this computer have an older app");
    expect(Buffer.byteLength(one, "utf8")).toBeLessThan(700);
  });

  it("takes main's word from the private parent port, and only a whole number of phones", () => {
    expect(applyPhoneLinkMessage({ type: "openmausbot:included-x", access: null })).toBe(false);
    expect(applyPhoneLinkMessage(null)).toBe(false);
    expect(told(1)).toBe(true);
    const built = buildSystemPrompt("You are Ada.", "", [phoneLinkPart()]);
    expect(built.sections.find((section) => section.id === "phone-link")?.text).toBe(phoneLinkPrompt(1));
    expect(built.stable, "it changes only when the phones do, so it stays in the cached half").toContain("Phone link:");
    for (const bad of [-1, 1.5, "2", 101, null]) expect(() => told(bad), String(bad)).toThrow(/invalid phone link fact/);
    expect(phoneLinkPart().text, "a bad message changes nothing").toBe(phoneLinkPrompt(1));
    told(0);
    expect(phoneLinkPart().text, "every phone updated and paired again").toBe("");
  });
});
