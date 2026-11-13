import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { codeUntil, lastSeen } from "../lib/pairing-time";
import { canPairDevices, pairingBlockedReason, phoneSecretNote, ServerPairingCard, shownDevices } from "./ServerPairingCard";

describe("pairing devices from a hosted server's settings", () => {
  it("is offered to the owner on the box and to admin sessions, never to chat-only sessions", () => {
    expect(canPairDevices({ kind: "loopback" })).toBe(true);
    expect(canPairDevices({ kind: "loopback", trust: "service" })).toBe(false);
    expect(canPairDevices({ kind: "session", id: "s", label: "Her iPad", scopes: ["admin", "client"], expiresAt: 1 })).toBe(true);
    expect(canPairDevices({ kind: "session", id: "s", label: "Staff phone", scopes: ["client"], expiresAt: 1 })).toBe(false);
    expect(canPairDevices({ kind: "unauthenticated", error: "pair" })).toBe(false);
    expect(canPairDevices(null)).toBe(false);
  });

  it("says until when a code works as a clock time, and when a device was last seen", () => {
    expect(codeUntil(new Date(2026, 10, 7, 11, 14).getTime())).toBe("Works once, until 11:14 AM");
    expect(lastSeen(1_000, 30_000)).toBe("just now");
    expect(lastSeen(0, 3 * 60_000)).toBe("3 min ago");
    expect(lastSeen(0, 5 * 3_600_000)).toBe("5 h ago");
    expect(lastSeen(0, 3 * 86_400_000)).toBe("3 d ago");
  });

  it("renders nothing until it knows who is asking", () => {
    expect(renderToStaticMarkup(createElement(ServerPairingCard))).toBe("");
  });

  it("offers every member of a Team Cloud a code for their own phone, never the admins' pairing", () => {
    const member = { kind: "session" as const, id: "s", label: "Desktop", scopes: ["client"], expiresAt: 1, team: { id: "team-acme-1", name: "Acme", role: "member" } };
    const html = renderToStaticMarkup(createElement(ServerPairingCard, { initialSession: member, cloudHome: true, team: "Acme" }));
    expect(html).toContain("Open on your phone");
    expect(html).toContain("Your phone opens Acme as you");
    expect(html).toContain("data-phone-pairing-action");
    expect(html).not.toContain("data-server-pairing-chat-only");
    expect(html).not.toContain("server-pairing-scope");
    const admin = renderToStaticMarkup(createElement(ServerPairingCard, { initialSession: { ...member, scopes: ["admin", "client"], team: { ...member.team, role: "admin" } }, cloudHome: true, team: "Acme" }));
    expect(admin).toContain("Open on your phone");
    expect(admin).not.toContain("Pair a phone or another computer");
  });

  it("explains a chat-only connection instead of showing nothing", () => {
    const chatOnly = { kind: "session" as const, id: "s", label: "Mac Studio", scopes: ["client"], expiresAt: 1 };
    expect(pairingBlockedReason(chatOnly)).toBe("chat-only");
    expect(pairingBlockedReason({ kind: "loopback" })).toBeNull();
    expect(pairingBlockedReason({ kind: "unauthenticated", error: "pair" })).toBeNull();
    const html = renderToStaticMarkup(createElement(ServerPairingCard, { initialSession: chatOnly }));
    expect(html).toContain("data-server-pairing-chat-only");
    expect(html).toContain("openmausbot pair");
    expect(html).toContain("This device has chat and approvals only, so it can&#x27;t pair others.");
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*data-phone-pairing-action[^>]*>Pair a phone<\/button>/);
    const admin = renderToStaticMarkup(createElement(ServerPairingCard, { initialSession: { ...chatOnly, scopes: ["admin", "client"] } }));
    expect(admin).not.toContain("data-server-pairing-chat-only");
    expect(admin).toMatch(/<button[^>]*data-phone-pairing-action[^>]*>Pair a phone<\/button>/);
    expect(admin.match(/data-phone-pairing-action/g)?.length).toBe(1);
    expect(admin).toContain('data-phone-pairing="server"');
    expect(html).toContain('data-phone-pairing="server"');
  });

  it("offers no pairing code on a hosted workspace, where people sign in through the portal", () => {
    const admin = { kind: "session" as const, id: "s", label: "Hosted workspace", scopes: ["admin", "client"], expiresAt: 1 };
    const html = renderToStaticMarkup(createElement(ServerPairingCard, { initialSession: admin, initialPairingCodes: false }));
    expect(html).toContain("data-server-pairing-portal");
    expect(html).toContain("organization&#x27;s Admin");
    expect(html).toContain("pairing codes are off");
    expect(html).not.toMatch(/pairing code from|openmausbot pair/);
    expect(html).not.toContain("Get for iPhone");
    const member = renderToStaticMarkup(createElement(ServerPairingCard, { initialSession: { ...admin, scopes: ["client"] }, initialPairingCodes: false }));
    expect(member).toContain("data-server-pairing-chat-only");
    expect(member).not.toContain("openmausbot pair");
  });

  it("on an OMB Cloud home, which is personal, offers no chat-only choice, lists only the owner's devices, and says why in one line", () => {
    const admin = { kind: "session" as const, id: "s", label: "Mac", scopes: ["admin", "client"], expiresAt: 1 };
    const cloud = renderToStaticMarkup(createElement(ServerPairingCard, { initialSession: admin, cloudHome: true, placeName: "My Cloud" }));
    expect(cloud).toContain(">Pair a phone<");
    expect(cloud).not.toContain("Chat and approvals only");
    expect(cloud, "one untitled row says what to do; the code and \"scan this code\" are only in the dialog").toContain("Install MausBot on your phone from the App Store or Google Play, then pair it here.");
    expect(cloud).not.toContain("is always on");
    const elsewhere = renderToStaticMarkup(createElement(ServerPairingCard, { initialSession: admin }));
    expect(elsewhere).toContain("Chat and approvals only");
    const devices = [
      { id: "a", label: "Mac", scopes: ["admin", "client"], lastSeenAt: 0, expiresAt: 1 },
      { id: "b", label: "Old phone", scopes: ["client"], lastSeenAt: 0, expiresAt: 1 },
    ];
    expect(shownDevices(devices, true).map((device) => device.id)).toEqual(["a"]);
    expect(shownDevices(devices, false).map((device) => device.id)).toEqual(["a", "b"]);
  });

  it("says under the code that secrets go on the web when the server has no phone key, and nothing otherwise", () => {
    expect(phoneSecretNote({ phoneSecrets: false })).toBe("This phone can chat and approve here, but secrets must be entered on the web or computer.");
    expect(phoneSecretNote({ phoneSecrets: true })).toBeNull();
    expect(phoneSecretNote({})).toBeNull();
  });
});
