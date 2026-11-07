import { describe, expect, it } from "vitest";
import { signInSeats, meterLedgerText, personEmail, recordWorkspaceEvent } from "./fleet-metering.ts";
import { parsePeopleResult } from "./fleet-tenant-io.ts";
import { summarizeUsage, type UsageRow, type UsageTrigger } from "./usage-ledger.ts";

const row = (trigger: UsageTrigger, overrides: Partial<UsageRow> = {}): UsageRow => ({
  at: "2026-09-10T10:00:00.000Z", botId: "b", botName: "B", threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "m",
  input: 10, output: 5, costUsd: 0.25, trigger, ...overrides,
});
const ledger = (...rows: unknown[]) => `${rows.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n")}\n`;
const meter = (rows: unknown[], month = "2026-09") => meterLedgerText(ledger(...rows), month);

describe("who is a billable person", () => {
  it.each<[string, UsageTrigger, { id: string; kind: "email" | "device" } | null]>([
    ["a signed-in user", { kind: "user", email: "Ada@Example.test", label: "Ada's phone" }, { id: "ada@example.test", kind: "email" }],
    ["a user with an untidy address", { kind: "user", email: "  ADA@Example.TEST " }, { id: "ada@example.test", kind: "email" }],
    ["a paired device with a label only", { kind: "user", label: "Ada's iPhone" }, { id: "device:ada's iphone", kind: "device" }],
    ["a full-width label folds to its plain form", { kind: "user", label: "ＡＤＡ Phone" }, { id: "device:ada phone", kind: "device" }],
    ["this computer without an email", { kind: "owner" }, null],
    ["this computer with an email", { kind: "owner", email: "boss@example.test" }, null],
    ["a routine without an email", { kind: "routine", routineId: "r1", label: "Nightly" }, null],
    ["a routine with an email", { kind: "routine", routineId: "r1", email: "boss@example.test" }, null],
    ["bot to bot", { kind: "bot", botId: "other" }, null],
    ["a bot to bot row carrying an email", { kind: "bot", botId: "other", email: "boss@example.test" }, null],
    ["a helper", { kind: "helper", botId: "b", job: "tidy" }, null],
  ])("%s", (_name, trigger, seat) => {
    const result = meter([row(trigger)]);
    expect(result.people.map(({ id, kind }) => ({ id, kind }))).toEqual(seat ? [seat] : []);
    expect(result.turns).toBe(1);
    expect(result.unattributedTurns).toBe(0);
  });

  it("counts a user row without a usable email or label as unattributed, not as a person", () => {
    const result = meter([
      row({ kind: "user" }),
      row({ kind: "user", email: "not an address", label: "   " }),
      row({ kind: "user", email: "a@b" }),
      row({ kind: "user", label: "bad\u0007label" }),
      row({ kind: "user", label: "x".repeat(300) }),
    ]);
    expect(result.people).toEqual([]);
    expect(result.unattributedTurns).toBe(5);
  });

  it("falls back to the device label when the email is not strictly shaped", () => {
    expect(meter([row({ kind: "user", email: "a..b@x.test", label: "Pad" })]).people.map((person) => person.id)).toEqual(["device:pad"]);
    expect(personEmail("a..b@x.test")).toBeUndefined();
    expect(personEmail("a@x")).toBeUndefined();
    expect(personEmail("a b@x.test")).toBeUndefined();
    expect(personEmail("<a@x.test>")).toBeUndefined();
    expect(personEmail("o'brien+tag@sub.x.test")).toBe("o'brien+tag@sub.x.test");
  });

  it("is case-insensitive and never merges aliases", () => {
    const result = meter([
      row({ kind: "user", email: "Ada@X.test" }),
      row({ kind: "user", email: "ada@x.test" }),
      row({ kind: "user", email: "ada+work@x.test" }),
      row({ kind: "user", email: "ada@mail.x.test" }),
    ]);
    expect(result.people.map(({ id, asked }) => [id, asked])).toEqual([["ada+work@x.test", 1], ["ada@mail.x.test", 1], ["ada@x.test", 2]]);
  });

  it("does not seat someone whose only turns failed, but still books their cost once they are a seat", () => {
    const failed = (email: string) => row({ kind: "user", email }, { outcome: { status: "error" }, costUsd: 1 });
    expect(meter([failed("ghost@x.test")]).people).toEqual([]);
    expect(meter([failed("ghost@x.test")]).unattributedTurns).toBe(0);
    const result = meter([row({ kind: "user", email: "ada@x.test" }, { outcome: { status: "ok" } }), failed("ada@x.test")]);
    expect(result.people).toEqual([{ id: "ada@x.test", kind: "email", asked: 1, attributed: 2, costUsd: 1.25 }]);
  });

  it("adds an owner, routine or bot row's cost to a person only when that person is already a seat", () => {
    const result = meter([
      row({ kind: "owner", email: "stranger@x.test" }, { costUsd: 9 }),
      row({ kind: "routine", routineId: "r", email: "ada@x.test" }, { costUsd: 0.5 }),
      row({ kind: "user", email: "ada@x.test" }, { costUsd: 0.25 }),
      row({ kind: "bot", botId: "b2", email: "Ada@X.test" }, { costUsd: 0.125 }),
    ]);
    expect(result.people).toEqual([{ id: "ada@x.test", kind: "email", asked: 1, attributed: 3, costUsd: 0.875 }]);
    expect(result.turns).toBe(4);
    expect(result.costUsd).toBeCloseTo(9.875, 9);
  });
});

describe("the month window and bad lines", () => {
  const at = (iso: string) => row({ kind: "user", email: "ada@x.test" }, { at: iso });

  it("is the UTC calendar month: the last second of August is out, the first instant of September is in", () => {
    const september = meter([at("2026-08-31T23:59:59.999Z"), at("2026-09-01T00:00:00.000Z"), at("2026-09-30T23:59:59.999Z"), at("2026-10-01T00:00:00.000Z")]);
    expect(september.turns).toBe(2);
    expect(september.people[0]).toMatchObject({ asked: 2 });
    expect(meter([at("2026-08-31T23:59:59Z")]).turns).toBe(0);
    expect(meter([at("2026-09-01T00:00:00Z")]).turns).toBe(1);
    expect(meter([at("2026-09-01T02:00:00+03:00")], "2026-08").turns).toBe(1);
  });

  it("ignores other months without calling them damaged", () => {
    const result = meter([at("2026-08-15T00:00:00Z"), at("2026-10-15T00:00:00Z"), at("2026-09-15T00:00:00Z")]);
    expect(result).toMatchObject({ turns: 1, ignoredLines: 0 });
  });

  it("counts torn, non-row and undated lines as ignored and keeps going", () => {
    const text = ledger(at("2026-09-02T00:00:00Z"), "{not json", "[]", "null", '"text"', { at: "2026-09-02T00:00:00Z" }, { ...at("2026-09-02T00:00:00Z"), at: "yesterday" }, { ...at("2026-09-02T00:00:00Z"), trigger: null }, "", "   ")
      + '{"at":"2026-09-03T00:00:00Z","botId":"b","mod';
    const result = meterLedgerText(text, "2026-09");
    expect(result).toMatchObject({ turns: 1, ignoredLines: 7 + 1 });
    expect(result.people).toHaveLength(1);
  });

  it("drops a line longer than 1 MiB without parsing it", () => {
    const huge = JSON.stringify({ ...at("2026-09-02T00:00:00Z"), padding: "x".repeat(1024 * 1024) });
    expect(meterLedgerText(ledger(huge, at("2026-09-03T00:00:00Z")), "2026-09")).toMatchObject({ turns: 1, ignoredLines: 1 });
  });

  it("counts a turn whose cost is negative, text or missing, but never adds that cost", () => {
    const result = meter([
      row({ kind: "user", email: "a@x.test" }, { costUsd: -5 }),
      row({ kind: "user", email: "a@x.test" }, { costUsd: "NaN" as unknown as number }),
      row({ kind: "user", email: "a@x.test" }, { costUsd: null }),
      { ...row({ kind: "user", email: "a@x.test" }), costUsd: undefined },
    ]);
    expect(result).toMatchObject({ turns: 4, costUsd: null });
    expect(result.people[0]).toMatchObject({ asked: 4, attributed: 4, costUsd: null });
    expect(meter([row({ kind: "user", email: "a@x.test" }, { costUsd: 0 })]).costUsd).toBe(0);
  });

  it("refuses a total that overflows rather than reporting infinity", () => {
    expect(() => meter([row({ kind: "owner" }, { costUsd: Number.MAX_VALUE }), row({ kind: "owner" }, { costUsd: Number.MAX_VALUE })])).toThrow("exceeds numeric range");
  });
});

describe("the people limit", () => {
  const distinct = (count: number) => Array.from({ length: count }, (_, index) => row({ kind: "user", email: `u${index}@x.test` }));

  it("allows 1000 people by default and refuses the 1001st", () => {
    expect(meterLedgerText(ledger(...distinct(1000)), "2026-09").people).toHaveLength(1000);
    expect(() => meterLedgerText(ledger(...distinct(1001)), "2026-09")).toThrow("more than 1000");
  });

  it("raises the limit to 10000 and no further", () => {
    expect(meterLedgerText(ledger(...distinct(1500)), "2026-09", 2000).people).toHaveLength(1500);
    expect(() => meterLedgerText("", "2026-09", 10_001)).toThrow("1 to 10000");
    expect(() => meterLedgerText("", "2026-09", 0)).toThrow("1 to 10000");
    expect(() => meterLedgerText("", "2026-09", 1.5)).toThrow("1 to 10000");
  });

  it("rejects a malformed month", () => {
    for (const month of ["2026-13", "2026-9", "26-09", "2026-09-01", ""]) expect(() => meterLedgerText("", month)).toThrow("YYYY-MM");
  });
});

describe("parity with the usage ledger's own per-person grouping", () => {
  const rows = [
    row({ kind: "user", email: "Ada@X.test", label: "Ada's phone" }, { costUsd: 0.5 }),
    row({ kind: "user", email: "ada@x.test" }, { costUsd: 0.25 }),
    row({ kind: "user", email: "bo@x.test" }, { costUsd: null }),
    row({ kind: "user", label: "Cy's Phone" }, { costUsd: 0.125 }),
    row({ kind: "routine", routineId: "r", email: "bo@x.test" }, { costUsd: 0.0625 }),
    row({ kind: "owner" }, { costUsd: 1 }),
    row({ kind: "bot", botId: "z" }, { costUsd: 2 }),
  ];

  it("names the same people, with the same turns and cost, as the user groups of summarizeUsage", () => {
    const groups = summarizeUsage(rows, "user").groups.filter((group) => group.key.startsWith("user:"));
    const people = meter(rows).people;
    const asKey = (id: string) => `user:${id.replace(/^device:/, "")}`;
    expect(people.map((person) => asKey(person.id)).sort()).toEqual(groups.map((group) => group.key).sort());
    for (const group of groups) {
      const person = people.find((entry) => asKey(entry.id) === group.key)!;
      expect(person.attributed).toBe(group.turns);
      expect(person.costUsd).toBe(group.costUsd);
    }
  });

  it("differs in exactly one documented way: a stranger's email on an owner row is a group there and no person here", () => {
    const withStranger = [...rows, row({ kind: "owner", email: "stranger@x.test" })];
    expect(summarizeUsage(withStranger, "user").groups.map((group) => group.key)).toContain("user:stranger@x.test");
    expect(meter(withStranger).people.map((person) => person.id)).not.toContain("stranger@x.test");
  });
});

describe("sign-in seats", () => {
  it("counts addresses and domains once, ignoring case and junk", () => {
    expect(signInSeats(JSON.stringify({ signIn: { admins: ["Ada@x.test", "ada@x.test"], members: ["bo@x.test", "@acme.test", "@ACME.test", "", 7, "plain"] } }))).toEqual({ emails: 2, domains: 1 });
    expect(signInSeats(null)).toEqual({ emails: 0, domains: 0 });
    expect(signInSeats("{broken")).toEqual({ emails: 0, domains: 0 });
    expect(signInSeats('{"signIn":[]}')).toEqual({ emails: 0, domains: 0 });
  });

  it("is reported alongside the ledger without touching the people", () => {
    const result = meterLedgerText(ledger(row({ kind: "owner" })), "2026-09", undefined, JSON.stringify({ signIn: { admins: ["a@x.test"], members: ["@acme.test"] } }));
    expect(result.seats).toEqual({ emails: 1, domains: 1 });
    expect(result.people).toEqual([]);
  });
});

describe("recordWorkspaceEvent", () => {
  const workspace = { slug: "acme", host: "acme.example.test", port: 8810, webhookPort: 8811, status: "running" as const, createdAt: "2026-08-01T00:00:00.000Z" };

  it("appends the time and status without changing the workspace", () => {
    const first = recordWorkspaceEvent(workspace, "running", "2026-08-01T00:00:00.000Z");
    const second = recordWorkspaceEvent({ ...first, status: "suspended" }, "suspended", "2026-09-10T00:00:00.000Z");
    expect(second.events).toEqual([{ at: "2026-08-01T00:00:00.000Z", status: "running" }, { at: "2026-09-10T00:00:00.000Z", status: "suspended" }]);
    expect(workspace).not.toHaveProperty("events");
  });

  it("keeps the newest hundred", () => {
    let current = workspace as ReturnType<typeof recordWorkspaceEvent>;
    for (let index = 0; index < 130; index++) current = recordWorkspaceEvent(current, index % 2 ? "suspended" : "running", new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString());
    expect(current.events).toHaveLength(100);
    expect(current.events![0]!.at).toBe(new Date(Date.UTC(2026, 0, 1, 0, 30)).toISOString());
    expect(current.events!.at(-1)!.at).toBe(new Date(Date.UTC(2026, 0, 1, 0, 129)).toISOString());
  });

  it("refuses a time the registry would later refuse to load", () => {
    for (const at of ["yesterday", "2026-09-10", "2026-09-10T00:00:00Z", ""]) expect(() => recordWorkspaceEvent(workspace, "running", at)).toThrow("ISO time");
  });
});

describe("parsePeopleResult", () => {
  const valid = () => ({
    v: 1, month: "2026-09", turns: 3, costUsd: 0.75, ignoredLines: 0, unattributedTurns: 1,
    people: [{ id: "ada@x.test", kind: "email", asked: 1, attributed: 1, costUsd: 0.25 }, { id: "device:ada's phone", kind: "device", asked: 1, attributed: 1, costUsd: null }],
    seats: { emails: 2, domains: 0 },
  });

  it("returns a well-formed result unchanged", () => {
    expect(parsePeopleResult(valid())).toEqual(valid());
  });

  it("agrees with the metering that produced it", () => {
    const result = meter([row({ kind: "user", email: "a@x.test" }), row({ kind: "user", label: "Phone" }), row({ kind: "user" })]);
    expect(parsePeopleResult(JSON.parse(JSON.stringify(result)), 1000, "2026-09")).toEqual(result);
  });

  it("rejects more people than the limit, 1001 by default", () => {
    const many = (count: number) => ({ ...valid(), turns: count, unattributedTurns: 0, people: Array.from({ length: count }, (_, index) => ({ id: `u${index}@x.test`, kind: "email", asked: 1, attributed: 1, costUsd: null })) });
    expect(parsePeopleResult(many(1000)).people).toHaveLength(1000);
    expect(() => parsePeopleResult(many(1001))).toThrow("more than 1000");
    expect(parsePeopleResult(many(1001), 2000).people).toHaveLength(1001);
  });

  it("rejects a 255-character id and accepts 254", () => {
    const withId = (id: string) => ({ ...valid(), people: [{ id, kind: "email", asked: 1, attributed: 1, costUsd: null }] });
    expect(() => parsePeopleResult(withId(`${"a".repeat(242)}@example.test`))).toThrow("1 to 254");
    expect(parsePeopleResult(withId(`${"a".repeat(241)}@example.test`)).people).toHaveLength(1);
  });

  it("rejects non-finite, negative and fractional numbers", () => {
    const patch = (value: Record<string, unknown>) => ({ ...valid(), ...value });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, "3", null, undefined]) expect(() => parsePeopleResult(patch({ turns: bad }))).toThrow();
    for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY, -0.01, "1"]) expect(() => parsePeopleResult(patch({ costUsd: bad }))).toThrow();
    expect(() => parsePeopleResult({ ...valid(), people: [{ id: "a@x.test", kind: "email", asked: 1, attributed: 1, costUsd: Number.POSITIVE_INFINITY }] })).toThrow("costUsd");
    expect(() => parsePeopleResult(patch({ seats: { emails: -1, domains: 0 } }))).toThrow("seats.emails");
  });

  it("rejects the wrong shape rather than repairing it", () => {
    const bad: unknown[] = [
      null, [], "text", {}, { ...valid(), v: 2 }, { ...valid(), extra: 1 }, { ...valid(), month: "2026-13" }, { ...valid(), people: "none" },
      { ...valid(), people: [{ id: "a@x.test", kind: "email", asked: 1, attributed: 1, costUsd: null, secret: "x" }] },
      { ...valid(), people: [{ id: "a@x.test", kind: "robot", asked: 1, attributed: 1, costUsd: null }] },
      { ...valid(), people: [{ id: "device:x", kind: "email", asked: 1, attributed: 1, costUsd: null }] },
      { ...valid(), people: [{ id: "x@y.test", kind: "device", asked: 1, attributed: 1, costUsd: null }] },
      { ...valid(), people: [{ id: "A@x.test", kind: "email", asked: 1, attributed: 1, costUsd: null }] },
      { ...valid(), people: [{ id: "a@x.test\nb", kind: "email", asked: 1, attributed: 1, costUsd: null }] },
      { ...valid(), people: [valid().people[0], valid().people[0]] },
      { ...valid(), turns: 1, unattributedTurns: 1 },
      { ...valid(), seats: { emails: 1 } },
    ];
    for (const raw of bad) expect(() => parsePeopleResult(raw)).toThrow();
    expect(() => parsePeopleResult(valid(), 1000, "2026-08")).toThrow("another month");
  });
});
