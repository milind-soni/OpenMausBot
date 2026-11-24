import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { handedOwnServerLender, lendingPerson, lendingPersonKey, OWN_SERVER_LENDER, ownWindowLender, personKey } from "./person-key.ts";
import { SharedComputers } from "./shared-computers.ts";

type Device = Parameters<typeof lendingPersonKey>[0];
const OWN = { admin: null };
const ME = "me@example.com";
const SIGNED_IN = { admin: ME };
const device = (fields: Partial<Device> = {}): Device => ({ id: randomUUID(), scopes: ["admin", "client"], ...fields });

describe("shared computers on a self-hosted server without email sign-in", () => {
  it("a paired phone with full access sees the PC its desktop lends", () => {
    const desktop = device(), phone = device();
    expect(personKey(desktop)).not.toBe(personKey(phone));
    const broker = new SharedComputers((id) => id === desktop.id);
    const computer = { id: randomUUID(), name: "PC B", environmentId: randomUUID(), folders: [], terminal: true, computer: false };
    broker.register(computer, { session: desktop.id, person: lendingPersonKey(desktop, OWN) }, "a".repeat(64));
    // A turn the phone started is known only by the key on its message.
    const fromPhone = lendingPerson(personKey(phone), OWN, () => [desktop, phone]);
    expect(broker.list(fromPhone).map((entry) => entry.id)).toEqual([computer.id]);
    broker.close();
  });

  it("every full-access device without email is one lender; nothing else changes who is who", () => {
    const desktop = device(), phone = device({ scopes: ["admin"] });
    expect(lendingPersonKey(desktop, OWN)).toBe(OWN_SERVER_LENDER);
    expect(lendingPersonKey(phone, OWN)).toBe(OWN_SERVER_LENDER);
    expect(personKey(desktop)).not.toBe(OWN_SERVER_LENDER);
  });

  it("on a server more than one person uses, each device stays its own person", () => {
    const desktop = device(), phone = device({ scopes: ["admin"] });
    expect(lendingPersonKey(desktop, null)).toBe(personKey(desktop));
    expect(lendingPerson(personKey(phone), null, () => [desktop, phone])).toBe(personKey(phone));
    expect(lendingPerson(null, OWN, () => [desktop])).toBeNull();
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
      expect(lendingPersonKey(other, OWN)).toBe(personKey(other));
      expect(lendingPerson(personKey(other), OWN, () => [desktop, other])).toBe(personKey(other));
    }
  });

  it("a device that is no longer paired, or a person relayed from another app, sees nothing of the lent PC", () => {
    const desktop = device(), revoked = device();
    expect(lendingPerson(personKey(revoked), OWN, () => [desktop])).toBe(personKey(revoked));
    expect(lendingPerson("p_relayed", OWN, () => [desktop])).toBe("p_relayed");
  });

  it("the one admin's email sign-ins and the paired devices are one lender", () => {
    const desktop = device({ email: "Me@Example.com " }), laptop = device({ email: ME }), phone = device();
    expect(lendingPersonKey(desktop, SIGNED_IN)).toBe(OWN_SERVER_LENDER);
    expect(lendingPersonKey(laptop, SIGNED_IN)).toBe(OWN_SERVER_LENDER);
    expect(lendingPersonKey(phone, SIGNED_IN)).toBe(OWN_SERVER_LENDER);
    const broker = new SharedComputers((id) => id === desktop.id);
    const computer = { id: randomUUID(), name: "PC B", environmentId: randomUUID(), folders: [], terminal: true, computer: false };
    broker.register(computer, { session: desktop.id, person: lendingPersonKey(desktop, SIGNED_IN) }, "a".repeat(64));
    // A turn the paired phone started, and one the admin started from another desktop by email.
    expect(broker.list(lendingPerson(personKey(phone), SIGNED_IN, () => [desktop, phone])).map((entry) => entry.id)).toEqual([computer.id]);
    expect(broker.list(lendingPerson(personKey(laptop), SIGNED_IN, () => [desktop])).map((entry) => entry.id)).toEqual([computer.id]);
    broker.close();
  });

  it("another address, a non-admin email session, or the admin's address on a server several people use keeps its own key", () => {
    const stranger = device({ email: "other@example.com" }), member = device({ email: ME, scopes: ["client"] }), desktop = device({ email: ME });
    expect(lendingPersonKey(stranger, SIGNED_IN)).toBe(personKey(stranger));
    expect(lendingPerson(personKey(stranger), SIGNED_IN, () => [stranger])).toBe(personKey(stranger));
    expect(lendingPersonKey(member, SIGNED_IN)).toBe(personKey(member));
    expect(lendingPersonKey(desktop, OWN), "no admin named").toBe(personKey(desktop));
    expect(lendingPerson(personKey(desktop), OWN, () => [desktop])).toBe(personKey(desktop));
    expect(lendingPersonKey(desktop, null)).toBe(personKey(desktop));
    expect(lendingPerson(personKey(desktop), null, () => [desktop])).toBe(personKey(desktop));
  });
});

describe("the desktop app's own window and work handed on, on a server of one person's own", () => {
  const lend = (desktop: Device) => {
    const broker = new SharedComputers((id) => id === desktop.id);
    const computer = { id: randomUUID(), name: "Mac B", environmentId: randomUUID(), folders: [], terminal: true, computer: true };
    broker.register(computer, { session: desktop.id, person: lendingPersonKey(desktop, OWN) }, "a".repeat(64));
    return { broker, computer };
  };

  it("a line typed in the server's own window sees the Mac a paired device lends", () => {
    const other = device();
    const { broker, computer } = lend(other);
    // That window has no session, so its line names no sender: before, a turn it started listed nothing.
    expect(broker.list(lendingPerson(null, OWN, () => [other]))).toEqual([]);
    const fromWindow = lendingPerson(ownWindowLender(OWN, true) ?? null, OWN, () => [other]);
    expect(broker.list(fromWindow).map((entry) => entry.id)).toEqual([computer.id]);
    broker.close();
  });

  it("only on a server of one person's own, and only for a line the window itself sent", () => {
    expect(ownWindowLender(null, true)).toBeUndefined();
    expect(ownWindowLender(OWN, false)).toBeUndefined();
    expect(ownWindowLender(SIGNED_IN, true)).toBe(OWN_SERVER_LENDER);
  });

  it("work the owner's turn handed on with the lent computer goes on seeing it", () => {
    const other = device();
    const { broker, computer } = lend(other);
    const sessions = () => [other];
    const fromWindow = { lends: true as const, person: OWN_SERVER_LENDER };
    expect(broker.list(handedOwnServerLender(OWN, fromWindow, OWN_SERVER_LENDER, sessions)).map((entry) => entry.id)).toEqual([computer.id]);
    const fromDevice = { lends: true as const, person: personKey(other) };
    expect(handedOwnServerLender(OWN, fromDevice, personKey(other), sessions)).toBe(OWN_SERVER_LENDER);
    broker.close();
  });

  it("handed-on work never lends without the hand-on's own record, for someone else, or on another server", () => {
    const owner = device(), guest = device({ scopes: ["client"] });
    const sessions = () => [owner, guest];
    expect(handedOwnServerLender(OWN, { person: OWN_SERVER_LENDER }, OWN_SERVER_LENDER, sessions)).toBeNull();
    expect(handedOwnServerLender(OWN, undefined, OWN_SERVER_LENDER, sessions)).toBeNull();
    // Someone else's words joined the work: it acts for nobody.
    expect(handedOwnServerLender(OWN, { lends: true, person: OWN_SERVER_LENDER }, null, sessions)).toBeNull();
    expect(handedOwnServerLender(OWN, { lends: true, person: OWN_SERVER_LENDER }, personKey(guest), sessions)).toBeNull();
    expect(handedOwnServerLender(OWN, { lends: true, person: personKey(guest) }, personKey(guest), sessions)).toBeNull();
    expect(handedOwnServerLender(OWN, { lends: true, person: personKey({ id: "", email: "else@example.com" }) }, personKey({ id: "", email: "else@example.com" }), sessions)).toBeNull();
    expect(handedOwnServerLender(null, { lends: true, person: personKey(owner) }, personKey(owner), sessions)).toBeNull();
  });
});
