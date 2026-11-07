import { describe, expect, it } from "vitest";
import { emptyRegistry, parseRegistry, type FleetRegistry, type FleetWorkspace } from "./fleet.ts";
import { parseEvents, parseMinorAmount, parseReseller, parseRetailOverride, type FleetReseller } from "./fleet-reseller.ts";

const reseller: FleetReseller = {
  name: "Acme Cloud",
  currency: "EUR",
  wholesale: { workspaceMonthMinor: 2500, userMonthMinor: 300 },
  retail: { workspaceMonthMinor: 4900, userMonthMinor: 500 },
  smtp: { urlFile: "/etc/openmausbot/smtp.url", from: "Acme <login@acme.example>" },
};
const workspace: FleetWorkspace = {
  slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: "2026-08-01T00:00:00.000Z",
  events: [{ at: "2026-08-01T00:00:00.000Z", status: "running" }, { at: "2026-08-15T09:30:00.000Z", status: "suspended" }],
  retailOverride: { userMonthMinor: 450 },
};
const serialise = (registry: FleetRegistry) => `${JSON.stringify(registry, null, 2)}\n`;

describe("fleet registry reseller fields", () => {
  it("round trips a reseller, events and a retail override", () => {
    const registry: FleetRegistry = { version: 1, domain: "agentada.cc", nextPort: 8820, operator: "maus", reseller, workspaces: { acme: workspace } };
    const text = serialise(registry);
    expect(parseRegistry(text)).toEqual(registry);
    expect(serialise(parseRegistry(text))).toBe(text);
  });

  it("parses an older registry unchanged and writes it back byte for byte", () => {
    const old: FleetRegistry = {
      version: 1, domain: "agentada.cc", nextPort: 8830, operator: "maus",
      workspaces: {
        acme: { slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: "2026-08-01T00:00:00.000Z" },
        old: { slug: "old", host: "old.agentada.cc", port: 8820, webhookPort: 8821, status: "retained", createdAt: "2026-01-01T00:00:00.000Z", accountCreated: true },
      },
    };
    const text = serialise(old);
    const parsed = parseRegistry(text);
    expect(parsed).toEqual(old);
    expect(parsed).not.toHaveProperty("reseller");
    expect(serialise(parsed)).toBe(text);
    expect(serialise(parseRegistry(serialise(emptyRegistry("agentada.cc"))))).toBe(serialise(emptyRegistry("agentada.cc")));
  });

  it("keeps fields it does not know on a workspace", () => {
    const text = JSON.stringify({ ...emptyRegistry("agentada.cc"), workspaces: { acme: { ...workspace, future: { kept: true } } } }, null, 2);
    expect(parseRegistry(text).workspaces.acme).toMatchObject({ future: { kept: true } });
  });

  it.each([
    ["a negative rate", { ...reseller, wholesale: { workspaceMonthMinor: -1, userMonthMinor: 0 } }],
    ["a fractional rate", { ...reseller, retail: { workspaceMonthMinor: 49.5, userMonthMinor: 0 } }],
    ["a NaN rate", { ...reseller, retail: { workspaceMonthMinor: Number.NaN, userMonthMinor: 0 } }],
    ["an unsafe integer rate", { ...reseller, retail: { workspaceMonthMinor: 2 ** 53, userMonthMinor: 0 } }],
    ["a missing rate", { ...reseller, retail: { workspaceMonthMinor: 1 } }],
    ["an unknown reseller key", { ...reseller, discount: 5 }],
    ["an unknown rate key", { ...reseller, retail: { workspaceMonthMinor: 1, userMonthMinor: 1, seats: 1 } }],
    ["a lowercase currency", { ...reseller, currency: "eur" }],
    ["a four letter currency", { ...reseller, currency: "EURO" }],
    ["an empty name", { ...reseller, name: "" }],
    ["a name over 40 characters", { ...reseller, name: "n".repeat(41) }],
    ["a name with a newline", { ...reseller, name: "Acme\nCloud" }],
    ["a relative smtp file", { ...reseller, smtp: { urlFile: "smtp.url", from: "a@b.example" } }],
    ["an unknown smtp key", { ...reseller, smtp: { urlFile: "/x", from: "a@b.example", url: "smtp://secret" } }],
    ["a string instead of an object", "acme"],
    ["null", null],
  ])("refuses %s", (_name, value) => {
    expect(() => parseReseller(value)).toThrow();
    expect(() => parseRegistry(JSON.stringify({ ...emptyRegistry("agentada.cc"), reseller: value }))).toThrow();
  });

  it("refuses malformed events and overrides instead of dropping them", () => {
    const events = (value: unknown) => () => parseEvents(value);
    expect(events("running")).toThrow();
    expect(events([{ at: "yesterday", status: "running" }])).toThrow();
    expect(events([{ at: "2026-08-01", status: "running" }])).toThrow();
    expect(events([{ at: "2026-08-01T00:00:00.000Z", status: "gone" }])).toThrow();
    expect(events([{ at: "2026-08-01T00:00:00.000Z", status: "running", by: "me" }])).toThrow();
    const many = Array.from({ length: 101 }, (_, index) => ({ at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), status: "running" }));
    expect(events(many)).toThrow(/at most 100/);
    expect(parseEvents(many.slice(0, 100))).toHaveLength(100);

    expect(() => parseRetailOverride({ workspaceMonthMinor: -5 })).toThrow();
    expect(() => parseRetailOverride({ userMonthMinor: 1.5 })).toThrow();
    expect(() => parseRetailOverride({ currency: "USD" })).toThrow();
    expect(() => parseRetailOverride([])).toThrow();
    expect(parseRetailOverride({})).toEqual({});

    for (const bad of [{ events: [{ at: "nope", status: "running" }] }, { retailOverride: { userMonthMinor: Number.MAX_VALUE } }, { events: null }]) {
      const text = JSON.stringify({ ...emptyRegistry("agentada.cc"), workspaces: { acme: { ...workspace, ...bad } } });
      expect(() => parseRegistry(text)).toThrow(/workspace "acme"/);
    }
  });

  it("turns amounts with at most two decimals into minor units", () => {
    expect(parseMinorAmount("49.00", "--x")).toBe(4900);
    expect(parseMinorAmount("49.5", "--x")).toBe(4950);
    expect(parseMinorAmount("0", "--x")).toBe(0);
    expect(parseMinorAmount("0.05", "--x")).toBe(5);
    for (const bad of ["", "-1", "1.234", "1,00", "1e3", " 1", ".5", "01", "12345678901"]) expect(() => parseMinorAmount(bad, "--x")).toThrow("--x");
  });
});
