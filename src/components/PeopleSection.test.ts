import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inviteLink, lastSeenLabel, mergePeople, PeopleTable, type Person } from "./PeopleSection";

describe("people helpers", () => {
  it("builds an invite link that opens the sign-in page with the address filled in", () => {
    expect(inviteLink("https://acme.agentada.cc/", "Bob@Acme.test")).toBe("https://acme.agentada.cc/pair?email=Bob%40Acme.test");
    expect(inviteLink("https://acme.agentada.cc", "@acme.test")).toBe("https://acme.agentada.cc/pair");
  });

  it("joins the sign-in list with devices and this month's usage, by address", () => {
    const people = mergePeople(
      { admins: ["Ada@Example.test"], members: ["bob@acme.test", "@acme.test", "ada@example.test"] },
      [
        { email: "ada@example.test", lastSeenAt: 1_000 },
        { email: "ADA@example.test", lastSeenAt: 5_000 },
        { label: "phone", lastSeenAt: 9_000 } as { email?: string; lastSeenAt: number },
      ],
      [{ key: "user:ada@example.test", turns: 12, costUsd: 3.5 }, { key: "owner", turns: 1, costUsd: 0.1 }],
    );
    expect(people).toEqual([
      { entry: "ada@example.test", role: "admin", isDomain: false, lastSeenAt: 5_000, devices: 2, turns: 12, costUsd: 3.5 },
      { entry: "bob@acme.test", role: "member", isDomain: false, lastSeenAt: null, devices: 0, turns: 0, costUsd: null },
      { entry: "@acme.test", role: "member", isDomain: true, lastSeenAt: null, devices: 0, turns: 0, costUsd: null },
    ]);
    expect(lastSeenLabel(null)).toBe("Never");
    expect(lastSeenLabel(Date.now() - 60_000)).toBe("Today");
    expect(lastSeenLabel(Date.parse("2026-09-01T12:00:00Z"), Date.parse("2026-09-10T12:00:00Z"))).toBe("2026-09-01");
  });
});

describe("people table", () => {
  const people: Person[] = [
    { entry: "ada@example.test", role: "admin", isDomain: false, lastSeenAt: null, devices: 2, turns: 12, costUsd: 3.5 },
    { entry: "@acme.test", role: "member", isDomain: true, lastSeenAt: null, devices: 0, turns: 0, costUsd: null },
  ];
  const noop = () => {};

  it("shows role chips, devices, spend, and the actions that fit each row", () => {
    const html = renderToStaticMarkup(createElement(PeopleTable, { people, busy: false, onRole: noop, onRemove: noop, onLink: noop }));
    expect(html).toContain("ada@example.test");
    expect(html).toContain("Admin");
    expect(html).toContain("2 device(s)");
    expect(html).toContain("$3.50");
    expect(html).toContain("Never");
    expect(html).toContain("everyone at acme.test");
    expect(html).toContain(">Make member<");
    expect(html).toContain(">Make admin<");
    expect(html).toContain(">Remove<");
    expect(html).toContain('aria-label="Invite link"');
  });

  it("says so when nobody is on the list", () => {
    expect(renderToStaticMarkup(createElement(PeopleTable, { people: [], busy: false, onRole: noop, onRemove: noop, onLink: noop }))).toContain("Nobody yet");
  });
});
