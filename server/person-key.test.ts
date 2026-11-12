import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { lendingPerson, lendingPersonKey, PAIRED_DEVICES_LENDER, personKey } from "./person-key.ts";
import { SharedComputers } from "./shared-computers.ts";

type Device = Parameters<typeof lendingPersonKey>[0];
const device = (fields: Partial<Device> = {}): Device => ({ id: randomUUID(), scopes: ["admin", "client"], ...fields });

describe("shared computers on a self-hosted server without email sign-in", () => {
  it("a paired phone with full access sees the PC its desktop lends", () => {
    const desktop = device(), phone = device();
    expect(personKey(desktop)).not.toBe(personKey(phone));
    const broker = new SharedComputers((id) => id === desktop.id);
    const computer = { id: randomUUID(), name: "PC B", environmentId: randomUUID(), folders: [], terminal: true, computer: false };
    broker.register(computer, { session: desktop.id, person: lendingPersonKey(desktop, true) }, "a".repeat(64));
    // A turn the phone started is known only by the key on its message.
    const fromPhone = lendingPerson(personKey(phone), true, () => [desktop, phone]);
    expect(broker.list(fromPhone).map((entry) => entry.id)).toEqual([computer.id]);
    broker.close();
  });

  it("every full-access device without email is one lender; nothing else changes who is who", () => {
    const desktop = device(), phone = device({ scopes: ["admin"] });
    expect(lendingPersonKey(desktop, true)).toBe(PAIRED_DEVICES_LENDER);
    expect(lendingPersonKey(phone, true)).toBe(PAIRED_DEVICES_LENDER);
    expect(personKey(desktop)).not.toBe(PAIRED_DEVICES_LENDER);
  });

  it("on a server more than one person uses, each device stays its own person", () => {
    const desktop = device(), phone = device({ scopes: ["admin"] });
    expect(lendingPersonKey(desktop, false)).toBe(personKey(desktop));
    expect(lendingPerson(personKey(phone), false, () => [desktop, phone])).toBe(personKey(phone));
    expect(lendingPerson(null, true, () => [desktop])).toBeNull();
  });

  it("a guest or limited pairing, a team member, a script token or an email sign-in keeps its own key", () => {
    const others = [
      device({ scopes: ["client"] }),
      device({ teamRole: "admin" }),
      device({ token: true }),
      device({ owner: "someone@example.com" }),
      device({ email: "me@example.com" }),
    ];
    const desktop = device();
    for (const other of others) {
      expect(lendingPersonKey(other, true)).toBe(personKey(other));
      expect(lendingPerson(personKey(other), true, () => [desktop, other])).toBe(personKey(other));
    }
  });

  it("a device that is no longer paired, or a person relayed from another app, sees nothing of the lent PC", () => {
    const desktop = device(), revoked = device();
    expect(lendingPerson(personKey(revoked), true, () => [desktop])).toBe(personKey(revoked));
    expect(lendingPerson("p_relayed", true, () => [desktop])).toBe("p_relayed");
  });
});
