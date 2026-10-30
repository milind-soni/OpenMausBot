import { describe, expect, it } from "vitest";

import { addressFor, addressRefusal, webhookAddress } from "./webhook-address.ts";

const SECRET = "whsec_fixture-only-secret-0123456789abcdef";
const webhook = { id: "hook-1", endpointId: "wh_abc", botId: "owner" };
const kept = { currentSecret: (id: string) => id === "hook-1" ? { webhook, secret: SECRET } as never : null };
const owner = { id: "owner", name: "Courier", section: "Ops" };
const ask = (from: Record<string, unknown>, extra: Partial<{ guestDriven: boolean; outsideDriven: boolean }> = {}) =>
  ({ from: { name: "Asker", ...from } as never, owner, guestDriven: false, outsideDriven: false, ...extra });

describe("who gets a webhook automation's address", () => {
  it("the bot that owns it, and a Chief of Staff that reaches that bot", () => {
    expect(addressRefusal(ask({ id: "owner", section: "Ops" }))).toBeNull();
    expect(addressRefusal(ask({ id: "chief", chiefOfStaff: true, section: "Ops" }))).toBeNull();
    expect(addressRefusal(ask({ id: "chief", chiefOfStaff: true, section: "Sales", managedSections: ["Ops"] }))).toBeNull();
  });

  it("never a teammate, a Chief that cannot reach the bot, or one whose audience differs on a shared workspace", () => {
    const only = "Only Courier, which owns this automation, or a Chief of Staff gets its address.";
    expect(addressRefusal(ask({ id: "peer", section: "Ops" }))).toBe(only);
    expect(addressRefusal(ask({ id: "chief", chiefOfStaff: true, section: "Sales" }))).toBe(only);
    expect(addressRefusal(ask({ id: "chief", chiefOfStaff: true, section: "Ops", peers: ["someone-else"] }))).toBe(only);
    expect(addressRefusal(ask({ id: "chief", chiefOfStaff: true, section: "Ops", visibility: { people: ["ada@example.com"] } }))).toBe(only);
  });

  it("never in a turn a guest or an outside event drives, even for the owner", () => {
    expect(addressRefusal(ask({ id: "owner", section: "Ops" }, { guestDriven: true }))).toContain("Only the Cloud's owner");
    expect(addressRefusal(ask({ id: "owner", section: "Ops" }, { outsideDriven: true }))).toContain("A run that an outside event started never gets");
    expect(addressFor(ask({ id: "owner", section: "Ops" }, { outsideDriven: true }), kept, "hook-1", "http://127.0.0.1:8800")).not.toHaveProperty("address");
  });
});

describe("the address", () => {
  it("is the full address, the endpoint and the bearer secret, with where to paste it and where never to", () => {
    const address = webhookAddress(kept, "hook-1", "https://acme.example.com/");
    expect(address).toMatchObject({ url: `https://acme.example.com/hooks/wh_abc/${SECRET}`, endpoint: "https://acme.example.com/hooks/wh_abc", bearer: SECRET });
    expect(address).toMatchObject({ note: expect.stringContaining("never repeat it in chat, notes, files or messages to other bots") });
    expect(JSON.stringify(address)).not.toContain("only apps running on it");
    expect(JSON.stringify(webhookAddress(kept, "hook-1", "http://127.0.0.1:8800"))).toContain("This address is on this computer, so only apps running on it can reach it.");
    expect(webhookAddress(kept, "missing", "http://127.0.0.1:8800")).toBeNull();
  });

  it("says so, and how the person gets it, when an app already holds an address from before addresses were kept", () => {
    const legacy = { currentSecret: () => ({ webhook, secret: null }) as never };
    expect(webhookAddress(legacy, "hook-1", "http://127.0.0.1:8800")).toEqual({ unavailable: expect.stringContaining("Copy address on the automation's card") });
    expect(addressFor(ask({ id: "owner", section: "Ops" }), legacy, "hook-1", "http://127.0.0.1:8800")).toMatchObject({ address: { unavailable: expect.any(String) } });
  });
});
