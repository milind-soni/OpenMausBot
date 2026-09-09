import { describe, expect, it } from "vitest";

import { buildBotOverview, connectedAppsFacts, soulLead, type OverviewFacts } from "./bot-overview.ts";

function baseFacts(overrides: Partial<OverviewFacts> = {}): OverviewFacts {
  return {
    bot: {
      name: "Kiwi",
      title: "Tracker",
      description: "Files bugs.",
      soul: "",
      computer: "off",
      cloudBackend: undefined,
      cwd: undefined,
      autoApprove: false,
      approvePeerComms: false,
      peers: [],
      composio: undefined,
      browser: undefined,
      chiefOfStaff: undefined,
    },
    routines: [],
    runs: [],
    webhooks: [],
    skills: [],
    engine: null,
    connectedApps: { configured: false, authoritative: true, services: [] },
    sectionPeers: 0,
    timeZone: "UTC",
    recent: [],
    ...overrides,
  };
}

const WONT_ORDER = [
  "Command approvals use Ask mode; saved permissions and provider rules still apply.",
  "Cannot initiate contact with other bots.",
  "Has no connected apps.",
  "Can't use a computer.",
  "Won't act on a schedule.",
  "Profile proposal cards require your approval.",
];

describe("buildBotOverview", () => {
  it("yields all six wont lines in order and no does lines for a fresh bot", () => {
    const overview = buildBotOverview(baseFacts());
    expect(overview.wont).toEqual(WONT_ORDER);
    expect(overview.does).toEqual([]);
  });

  it("drops the first wont line when autoApprove is on", () => {
    const overview = buildBotOverview(baseFacts({ bot: { ...baseFacts().bot, autoApprove: true } }));
    expect(overview.wont).toEqual(WONT_ORDER.slice(1));
  });

  it("uses the effective approval level rather than the legacy Auto bit", () => {
    const bot = { ...baseFacts().bot, approvalMode: "full" as const, autoApprove: false };
    expect(buildBotOverview(baseFacts({ bot })).wont).not.toContain(WONT_ORDER[0]);
    expect(buildBotOverview(baseFacts({ bot: { ...bot, approvalMode: "custom" } })).wont)
      .toContain("Command approvals follow the provider's custom configuration.");
  });

  it("does not advertise a browser disabled globally or unsupported by the engine", () => {
    const facts = baseFacts({ bot: { ...baseFacts().bot, computer: "browser" }, browserEnabled: true, engine: { browserMcp: false } });
    expect(buildBotOverview(facts).reaches).not.toContain("Has the built-in browser.");
    facts.engine = { browserMcp: true };
    facts.browserEnabled = false;
    expect(buildBotOverview(facts).reaches).not.toContain("Has the built-in browser.");
    facts.browserEnabled = true;
    expect(buildBotOverview(facts).reaches).toContain("Has the built-in browser.");
  });

  it("renders an enabled interval routine with its last completed run", () => {
    const facts = baseFacts({
      routines: [
        {
          id: "r1",
          name: "Triage Discord",
          enabled: true,
          schedule: { type: "interval", everyMinutes: 5, anchorAt: 1_000 },
          nextRunAt: 2_000,
        },
      ],
      runs: [
        { routineId: "r1", status: "completed", finishedAt: 1_500, scheduledFor: 1_000 },
      ],
    });
    const overview = buildBotOverview(facts);
    expect(overview.does).toHaveLength(1);
    // Prose, not the approval card's exact form: no anchor instant, no timezone name.
    expect(overview.does[0]).toMatch(/^Every 5 minutes: Triage Discord\./);
    expect(overview.does[0]).not.toContain("UTC");
    expect(overview.does[0]).not.toContain("anchored");
    expect(overview.does[0]).toContain("Last run completed at");
    expect(overview.does[0]).toContain("Next run");
    // Won't-act-on-a-schedule should not appear since an enabled routine exists.
    expect(overview.wont).not.toContain("Won't act on a schedule.");
  });

  it("renders a paused routine as Paused: name", () => {
    const facts = baseFacts({
      routines: [
        {
          id: "r2",
          name: "Nightly Backup",
          enabled: false,
          schedule: { type: "daily", time: "09:00", weekdays: [1] },
          nextRunAt: null,
        },
      ],
    });
    const overview = buildBotOverview(facts);
    expect(overview.does).toEqual(["Paused: Nightly Backup."]);
    // A paused-only routine set still has no enabled routine.
    expect(overview.wont).toContain("Won't act on a schedule.");
  });

  it("renders enabled skills and webhooks as their own does lines", () => {
    const facts = baseFacts({
      skills: [
        { name: "triage", description: "Triage incoming bug reports", enabled: true },
        { name: "disabled-skill", description: "Should not appear", enabled: false },
      ],
      webhooks: [
        { name: "Linear", enabled: true },
        { name: "Disabled hook", enabled: false },
      ],
    });
    const overview = buildBotOverview(facts);
    expect(overview.does).toEqual([
      "Knows how to triage incoming bug reports.",
      "Listens for “Linear” webhooks.",
    ]);
  });

  it("shows two connected services in reaches", () => {
    const facts = baseFacts({
      bot: { ...baseFacts().bot, composio: true, computer: "local" },
      engine: { composioMcp: true },
      connectedApps: { configured: true, authoritative: true, services: ["gmail", "linear"] },
    });
    const overview = buildBotOverview(facts);
    expect(overview.reaches).toContain("Can use 2 connected apps: gmail, linear.");
    expect(overview.wont).not.toContain("Has no connected apps.");
  });

  it("reports connected apps could not be checked when unauthoritative, without also claiming none connected", () => {
    const facts = baseFacts({
      bot: { ...baseFacts().bot, composio: true, computer: "local" },
      engine: { composioMcp: true },
      connectedApps: { configured: true, authoritative: false, services: [] },
    });
    const overview = buildBotOverview(facts);
    expect(overview.reaches).toContain("Connected apps could not be checked.");
    expect(overview.wont).not.toContain("Has no connected apps.");
    expect(overview.reaches.some((line) => line.startsWith("Can use"))).toBe(false);
  });

  it("states 'Has no connected apps.' when apps are off for the bot, even if the inventory is unverifiable", () => {
    // Apps off is a definite negative that needs no inventory — saying
    // "could not be checked" here would imply the bot might have apps.
    const facts = baseFacts({
      bot: { ...baseFacts().bot, composio: false, computer: "local" },
      engine: { composioMcp: true },
      connectedApps: { configured: true, authoritative: false, services: [] },
    });
    const overview = buildBotOverview(facts);
    expect(overview.wont).toContain("Has no connected apps.");
    expect(overview.reaches).not.toContain("Connected apps could not be checked.");
  });

  it("stays silent about apps in reaches when the engine cannot mount them", () => {
    const facts = baseFacts({
      bot: { ...baseFacts().bot, composio: true, computer: "local" },
      engine: { composioMcp: false },
      connectedApps: { configured: true, authoritative: false, services: ["gmail"] },
    });
    const overview = buildBotOverview(facts);
    expect(overview.wont).toContain("Has no connected apps.");
    expect(overview.reaches.some((line) => line.includes("connected app"))).toBe(false);
  });

  it("uses the singular for one connected app", () => {
    const facts = baseFacts({
      bot: { ...baseFacts().bot, composio: true, computer: "local" },
      engine: { composioMcp: true },
      connectedApps: { configured: true, authoritative: true, services: ["gmail"] },
    });
    expect(buildBotOverview(facts).reaches).toContain("Can use 1 connected app: gmail.");
  });

  it("writes daily and once schedules as prose", () => {
    const overview = buildBotOverview(baseFacts({
      routines: [
        { id: "a", name: "Standup", enabled: true, schedule: { type: "daily", time: "09:30", weekdays: [1, 2, 3, 4, 5] }, nextRunAt: null },
        { id: "b", name: "Digest", enabled: true, schedule: { type: "daily", time: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, nextRunAt: null },
        { id: "c", name: "Review", enabled: true, schedule: { type: "daily", time: "08:00", weekdays: [3] }, nextRunAt: null },
        { id: "d", name: "Launch", enabled: true, schedule: { type: "once", at: Date.UTC(2026, 8, 5, 12) }, nextRunAt: null },
        { id: "e", name: "Hourly", enabled: true, schedule: { type: "interval", everyMinutes: 60 }, nextRunAt: null },
      ],
    }));
    expect(overview.does).toEqual([
      "Every weekday at 9:30 AM: Standup.",
      "Every day at 6:00 PM: Digest.",
      "Weekly on Wednesday at 8:00 AM: Review.",
      "Once on September 5 at 12:00 PM: Launch.",
      "Every hour: Hourly.",
    ]);
  });

  it("picks a computer automatically and stays reachable by default when computer/peers are unset", () => {
    const facts = baseFacts({
      bot: { ...baseFacts().bot, computer: undefined, peers: undefined, approvePeerComms: false },
    });
    const overview = buildBotOverview(facts);
    expect(overview.reaches).toContain("Computer preference: Auto; availability is checked when a task starts.");
    expect(overview.wont).not.toContain("Can't use a computer.");
    expect(overview.wont).not.toContain("Won't contact other bots without asking.");
  });
});

describe("soulLead", () => {
  it("cuts at the first blank line", () => {
    expect(soulLead("First paragraph.\n\nSecond paragraph.")).toBe("First paragraph.");
  });

  it("cuts at 240 characters", () => {
    const long = "A".repeat(300);
    const result = soulLead(long);
    // Cut at 240 characters, with an ellipsis so the card says it is a cut.
    expect(result).toBe(`${"A".repeat(240)}…`);
  });

  it("returns an empty string for an unset soul", () => {
    expect(soulLead(undefined)).toBe("");
  });
});

describe("connectedAppsFacts", () => {
  it("lists the connected slugs when the inventory reads cleanly", async () => {
    const facts = await connectedAppsFacts(true, "configured", async () => ({
      gmail: { connected: true },
      linear: { connected: false },
    }));
    expect(facts).toEqual({ configured: true, authoritative: true, services: ["gmail"] });
  });

  it("marks the inventory unverified instead of throwing when the read fails", async () => {
    const facts = await connectedAppsFacts(true, "configured", async () => {
      throw new Error("Connected apps: HTTP 502");
    });
    expect(facts).toEqual({ configured: true, authoritative: false, services: [] });
  });

  it("never reads when the connector is unconfigured or the store was unreadable", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return {};
    };
    expect(await connectedAppsFacts(false, "unconfigured", read)).toEqual({ configured: false, authoritative: true, services: [] });
    expect(await connectedAppsFacts(false, "unreadable", read)).toEqual({ configured: false, authoritative: false, services: [] });
    expect(reads).toBe(0);
  });
});
