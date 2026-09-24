import { describe, expect, it } from "vitest";
import {
  beatWidth,
  beatsFor,
  companyModelCount,
  completionPatch,
  EMPTY_ONBOARDING,
  engineSummary,
  hintSeen,
  hostedMember,
  spotlightsQuiet,
  hintSeenPatch,
  LOCAL_VIEWER,
  nextBeat,
  organisationSignIn,
  previousBeat,
  welcomeDue,
  welcomeViewer,
  WELCOME_VERSION,
} from "./onboarding";

const done = { completedAt: "2026-09-09T10:00:00.000Z", version: WELCOME_VERSION, reelSeen: false, hintsSeen: [] };

describe("welcomeDue", () => {
  it("waits for the server before deciding", () => {
    expect(welcomeDue(null, { remoteClient: false, legacyDone: false })).toBe(false);
    expect(welcomeDue(undefined, { remoteClient: false, legacyDone: false })).toBe(false);
  });

  it("shows the tour to a fresh workspace", () => {
    expect(welcomeDue({}, { remoteClient: false, legacyDone: false })).toBe(true);
    expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { remoteClient: false, legacyDone: false })).toBe(true);
  });

  it("never shows it to a paired remote client", () => {
    expect(welcomeDue({}, { remoteClient: true, legacyDone: false })).toBe(false);
  });

  it("respects a completion at the current version", () => {
    expect(welcomeDue({ onboarding: done }, { remoteClient: false, legacyDone: false })).toBe(false);
  });

  it("re-shows a flow completed at an older version", () => {
    expect(welcomeDue({ onboarding: { ...done, version: WELCOME_VERSION - 1 } }, { remoteClient: false, legacyDone: false })).toBe(true);
  });

  it("honours the old localStorage gate for one release", () => {
    expect(welcomeDue({}, { remoteClient: false, legacyDone: true })).toBe(false);
    // but a server record, once present, wins over the browser
    expect(welcomeDue({ onboarding: { ...done, version: 0 } }, { remoteClient: false, legacyDone: true })).toBe(true);
  });

  it("decides who gets the tour on a fresh workspace", () => {
    const fresh = { onboarding: EMPTY_ONBOARDING };
    const cases = [
      // the desktop app's own window: exactly as before
      { who: "local desktop", options: { remoteClient: false, legacyDone: false, ...LOCAL_VIEWER }, due: true },
      { who: "remote client", options: { remoteClient: true, legacyDone: false, ...LOCAL_VIEWER }, due: false },
      { who: "hosted admin", options: { remoteClient: false, legacyDone: false, hosted: true, canSave: true }, due: true },
      // PUT /api/config is admin-only: a member could never finish it
      { who: "hosted member", options: { remoteClient: false, legacyDone: false, hosted: true, canSave: false }, due: false },
      { who: "member of a self-hosted server", options: { remoteClient: false, legacyDone: false, hosted: false, canSave: false }, due: false },
      // a hosted session that has not proved it may save waits
      { who: "hosted, scope unknown", options: { remoteClient: false, legacyDone: false, hosted: true }, due: false },
    ];
    for (const { who, options, due } of cases) expect(welcomeDue(fresh, options), who).toBe(due);
  });
});

describe("welcomeViewer", () => {
  it("reads the session defensively", () => {
    expect(welcomeViewer({ kind: "loopback", scopes: ["admin", "client"] })).toEqual({ hosted: false, canSave: true });
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], hosted: true })).toEqual({ hosted: true, canSave: true });
    expect(welcomeViewer({ kind: "session", scopes: ["client"], hosted: true })).toEqual({ hosted: true, canSave: false });
    expect(welcomeViewer({ kind: "session", scopes: ["client"] })).toEqual({ hosted: false, canSave: false });
    // a shared server's local service trust (no admin scope) cannot save either
    expect(welcomeViewer({ kind: "loopback", scopes: ["client"], trust: "service" })).toEqual({ hosted: false, canSave: false });
    // an answer without scopes is today's owner; only a literal true is hosted
    expect(welcomeViewer({})).toEqual(LOCAL_VIEWER);
    expect(welcomeViewer(null)).toEqual(LOCAL_VIEWER);
    expect(welcomeViewer({ scopes: ["admin"], hosted: "yes" })).toEqual({ hosted: false, canSave: true });
  });

  it("calls only a hosted session without admin scope a hosted member", () => {
    expect(hostedMember({ hosted: true, canSave: false })).toBe(true);
    expect(hostedMember({ hosted: true, canSave: true })).toBe(false);
    // the owner's own paired browser on a personal server is not a team member
    expect(hostedMember({ hosted: false, canSave: false })).toBe(false);
    expect(hostedMember(LOCAL_VIEWER)).toBe(false);
    expect(hostedMember(null)).toBe(false);
    // spotlights wait for the answer, then stay as before except for hosted members
    expect(spotlightsQuiet(null)).toBe(true);
    expect(spotlightsQuiet({ hosted: true, canSave: false })).toBe(true);
    expect(spotlightsQuiet({ hosted: false, canSave: false })).toBe(false);
    expect(spotlightsQuiet(LOCAL_VIEWER)).toBe(false);
  });
});

describe("organisation sign-in in the engines beat", () => {
  const bridge = { begin: () => {} };

  it("is offered only by the packaged local desktop", () => {
    expect(organisationSignIn({ organization: bridge }, { hosted: false })).toBe(bridge);
    expect(organisationSignIn(undefined, { hosted: false })).toBeUndefined();
    expect(organisationSignIn({}, { hosted: false })).toBeUndefined();
    expect(organisationSignIn({ organization: bridge, remoteClient: { active: true } }, { hosted: false })).toBeUndefined();
    expect(organisationSignIn({ organization: bridge }, { hosted: true })).toBeUndefined();
    expect(organisationSignIn({ organization: bridge, remoteClient: { active: false } }, { hosted: false })).toBe(bridge);
  });

  it("counts the models the organisation approved", () => {
    expect(companyModelCount(null)).toBe(0);
    expect(companyModelCount({})).toBe(0);
    expect(companyModelCount({ providers: [
      { configured: true, models: ["a", "b"] },
      { configured: false, models: ["c"] },
      { configured: true, models: ["d"] },
    ] })).toBe(3);
  });
});

describe("engineSummary", () => {
  type Row = { id: string; install?: object; managed?: object; ok: boolean };
  const ok = (row: Row) => row.ok;
  const personal = (id: string, ready: boolean): Row => ({ id, install: {}, ok: ready });
  const company = (id: string, ready: boolean): Row => ({ id, managed: { organizationId: "org", organizationName: "Org" }, ok: ready });

  it("counts a signed-in Company engine as ready when nothing personal is", () => {
    const rows = [personal("claude", false), personal("codex", false), company("company.claude", true)];
    const summary = engineSummary(rows, ok, { company: true });
    expect(summary.allReady).toBe(true);
    expect(summary.company).toBe(1);
    // personal rows stay listed, below, as before
    expect(summary.ready.map((row) => row.id)).toEqual([]);
    expect(summary.setup.map((row) => row.id)).toEqual(["claude", "codex"]);
  });

  it("does not count a Company engine that cannot run", () => {
    const summary = engineSummary([personal("claude", false), company("company.claude", false)], ok, { company: true });
    expect(summary.company).toBe(0);
    expect(summary.allReady).toBe(false);
  });

  it("counts exactly as before where organisation sign-in is not offered", () => {
    const rows = [personal("claude", true), personal("codex", false), company("company.claude", true)];
    const summary = engineSummary(rows, ok, { company: false });
    expect(summary).toEqual({ ready: [rows[0]], setup: [rows[1]], company: 0, allReady: false });
    expect(engineSummary([personal("claude", true)], ok, { company: false }).allReady).toBe(true);
    expect(engineSummary([], ok, { company: false }).allReady).toBe(false);
  });
});

describe("persistence patches", () => {
  it("stamps completion with the current version", () => {
    expect(completionPatch(new Date("2026-09-09T12:34:56.000Z"))).toEqual({
      onboarding: { completedAt: "2026-09-09T12:34:56.000Z", version: WELCOME_VERSION },
    });
  });

  it("adds a hint once and never writes a no-op", () => {
    expect(hintSeen(undefined, "computer")).toBe(false);
    expect(hintSeenPatch(undefined, "computer")).toEqual({ onboarding: { hintsSeen: ["computer"] } });
    const record = { ...EMPTY_ONBOARDING, hintsSeen: ["computer"] };
    expect(hintSeen(record, "computer")).toBe(true);
    expect(hintSeenPatch(record, "computer")).toBeNull();
    expect(hintSeenPatch(record, "apps")).toEqual({ onboarding: { hintsSeen: ["computer", "apps"] } });
  });
});

describe("beat machine", () => {
  it("lists beats for the desktop app with the reel off", () => {
    expect(beatsFor({ dictation: true, reel: false })).toEqual(["hello", "engines", "permissions", "phone", "bot"]);
  });

  it("drops the permissions beat where there is no microphone to ask for", () => {
    expect(beatsFor({ dictation: false, reel: false })).toEqual(["hello", "engines", "phone", "bot"]);
  });

  it("slots the reel after hello when enabled", () => {
    expect(beatsFor({ dictation: false, reel: true })).toEqual(["hello", "reel", "engines", "phone", "bot"]);
  });

  it("always ends on the bot beat", () => {
    for (const dictation of [true, false]) {
      for (const reel of [true, false]) {
        expect(beatsFor({ dictation, reel }).at(-1)).toBe("bot");
        expect(beatsFor({ dictation, reel, hosted: true }).at(-1)).toBe("bot");
      }
    }
  });

  it("gives a hosted workspace a greeting and the bot, nothing about this computer", () => {
    expect(beatsFor({ dictation: true, reel: true, hosted: true })).toEqual(["hello", "bot"]);
    expect(beatsFor({ dictation: true, reel: true, hosted: false })).toEqual(["hello", "reel", "engines", "permissions", "phone", "bot"]);
  });

  it("walks forward and back and stops at the ends", () => {
    const beats = beatsFor({ dictation: true, reel: false });
    expect(nextBeat(beats, "hello")).toBe("engines");
    expect(nextBeat(beats, "bot")).toBeNull();
    expect(previousBeat(beats, "engines")).toBe("hello");
    expect(previousBeat(beats, "hello")).toBeNull();
    expect(nextBeat(beats, "reel")).toBeNull();
  });

  it("gives the engines beat the widest card", () => {
    expect(beatWidth("engines")).toBeGreaterThan(beatWidth("hello"));
    expect(beatWidth("bot")).toBeGreaterThan(beatWidth("hello"));
  });
});
