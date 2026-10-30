import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aiChoices,
  aiWorks,
  beatsFor,
  cloudSignInDue,
  companyModelCount,
  completionPatch,
  EMPTY_ONBOARDING,
  firstRunPatch,
  hintSeen,
  hostedMember,
  spotlightsQuiet,
  hintSeenPatch,
  LOCAL_VIEWER,
  MET_CHIEF_HINT,
  onboardingCloudOffered,
  ONBOARDING_CLOUD_HINT,
  organisationSignIn,
  resumeBeat,
  showWelcome,
  welcomeOnScreen,
  welcomeAi,
  welcomeDue,
  welcomeViewer,
  WELCOME_VERSION,
  markWelcomeFinished,
  welcomeFinishedThisLaunch,
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
    expect(welcomeDue({ onboarding: { ...done, version: 0 } }, { remoteClient: false, legacyDone: true })).toBe(true);
  });

  it("decides who gets the tour on a fresh workspace", () => {
    const fresh = { onboarding: EMPTY_ONBOARDING };
    const cases = [
      { who: "local desktop", options: { remoteClient: false, legacyDone: false, ...LOCAL_VIEWER }, due: true },
      { who: "remote client", options: { remoteClient: true, legacyDone: false, ...LOCAL_VIEWER }, due: false },
      { who: "hosted admin", options: { remoteClient: false, legacyDone: false, hosted: true, canSave: true }, due: true },
      { who: "hosted member", options: { remoteClient: false, legacyDone: false, hosted: true, canSave: false }, due: false },
      { who: "member of a self-hosted server", options: { remoteClient: false, legacyDone: false, hosted: false, canSave: false }, due: false },
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
    expect(welcomeViewer({ kind: "loopback", scopes: ["client"], trust: "service" })).toEqual({ hosted: false, canSave: false });
    expect(welcomeViewer({})).toEqual(LOCAL_VIEWER);
    expect(welcomeViewer(null)).toEqual(LOCAL_VIEWER);
    expect(welcomeViewer({ scopes: ["admin"], hosted: "yes" })).toEqual({ hosted: false, canSave: true });
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], cloudHome: true })).toEqual({ hosted: false, canSave: true, cloudHome: true });
    expect(welcomeViewer({ kind: "session", scopes: ["admin", "client"], cloudHome: "yes" })).toEqual({ hosted: false, canSave: true });
  });

  it("calls only a hosted session without admin scope a hosted member", () => {
    expect(hostedMember({ hosted: true, canSave: false })).toBe(true);
    expect(hostedMember({ hosted: true, canSave: true })).toBe(false);
    expect(hostedMember({ hosted: false, canSave: false })).toBe(false);
    expect(hostedMember(LOCAL_VIEWER)).toBe(false);
    expect(hostedMember(null)).toBe(false);
    expect(spotlightsQuiet(null)).toBe(true);
    expect(spotlightsQuiet({ hosted: true, canSave: false })).toBe(true);
    expect(spotlightsQuiet({ hosted: false, canSave: false })).toBe(false);
    expect(spotlightsQuiet(LOCAL_VIEWER)).toBe(false);
  });
});

describe("first run on an OMB Cloud home", () => {
  const connected = welcomeViewer({ kind: "session", scopes: ["admin", "client"], via: "cookie", cloudHome: true });
  const engine = (id: string, authenticated: boolean | undefined, state = "available") => ({ id, state, authenticated });
  const ready = (instance: ReturnType<typeof engine>) => instance.state === "available" && instance.authenticated !== false;
  const signedOut = [engine("claude", false), engine("codex", false), engine("opencodeGo", undefined, "unavailable")];

  it("routes the connected app to the engine sign-in, not the welcome flow", () => {
    expect(cloudSignInDue(connected, { connected: true, instances: signedOut }, ready)).toBe(true);
    expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { remoteClient: false, legacyDone: false, ...connected })).toBe(false);
  });

  it("hands over to the chat once any engine can run", () => {
    for (const signedIn of [engine("claude", true), engine("codex", true), engine("anthropic-key", undefined)]) {
      expect(cloudSignInDue(connected, { connected: true, instances: [...signedOut, signedIn] }, ready)).toBe(false);
    }
  });

  it("waits for the server, and changes nothing anywhere else", () => {
    expect(cloudSignInDue(connected, { connected: false, instances: signedOut }, ready)).toBe(false);
    expect(cloudSignInDue(connected, { connected: true, instances: [] }, ready)).toBe(false);
    expect(cloudSignInDue(null, { connected: true, instances: signedOut }, ready)).toBe(false);
    expect(cloudSignInDue({ ...connected, canSave: false }, { connected: true, instances: signedOut }, ready)).toBe(false);
    for (const viewer of [LOCAL_VIEWER, { hosted: true, canSave: true }, welcomeViewer({ kind: "session", scopes: ["admin", "client"] })]) {
      expect(cloudSignInDue(viewer, { connected: true, instances: signedOut }, ready)).toBe(false);
      expect(welcomeDue({ onboarding: EMPTY_ONBOARDING }, { remoteClient: false, legacyDone: false, ...viewer })).toBe(true);
    }
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

describe("connecting an AI in the welcome", () => {
  type Row = { id: string; driverKind: string; access?: string; readOnly?: boolean };
  const row = (id: string, driverKind: string, extra: Partial<Row> = {}): Row => ({ id, driverKind, ...extra });

  it("recommends a Claude account first, then a ChatGPT plan, and folds every other way under it", () => {
    const grok = row("grok", "grokAgent");
    const codex = row("codex", "codex");
    const claudeKey = row("claude-api", "claudeAgent", { access: "api" });
    const claude = row("claude", "claudeAgent");
    expect(aiChoices([grok, codex, claudeKey, claude])).toEqual({ recommended: claude, others: [grok, codex, claudeKey] });
    expect(aiChoices([grok, claudeKey, codex]).recommended).toBe(codex);
    expect(aiChoices([grok, claudeKey]).recommended).toBe(grok);
    expect(aiChoices([row("company", "claudeAgent", { readOnly: true }), grok]).recommended, "an organization's model is not a sign-in").toBe(grok);
    expect(aiChoices([])).toEqual({ recommended: undefined, others: [] });
  });

  it("recommends in the same order the new-bot default uses: then Gemini, then Grok, then the rest as listed", () => {
    const kimi = row("kimi", "kimiAgent");
    const grok = row("grok", "grokAgent");
    const antigravity = row("antigravity", "antigravityAgent");
    expect(aiChoices([kimi, grok, antigravity]).recommended).toBe(antigravity);
    expect(aiChoices([kimi, grok])).toEqual({ recommended: grok, others: [kimi] });
    expect(aiChoices([kimi, row("droid", "droidAgent")]).recommended).toBe(kimi);
  });
});

describe("the AI the welcome stands on", () => {
  type Ai = { id: string; driverKind: string; ready: boolean; aiTest?: "testing" | "passed" | "failed" | "untestable"; snapshot?: { freeFallback?: boolean } };
  const ai = (id: string, driverKind: string, extra: Partial<Ai> = {}): Ai => ({ id, driverKind, ready: true, ...extra });
  const stand = (instances: Ai[]) => {
    const found = welcomeAi(instances, (instance) => instance.ready, (instance) => instance.aiTest);
    return found && { id: found.instance.id, state: found.state };
  };

  it("is none while only OpenCode's free backup works, so the welcome still asks for the person's own AI", () => {
    const backup = ai("opencodeGo", "opencodeGo", { snapshot: { freeFallback: true }, aiTest: "passed" });
    expect(stand([backup, ai("claude", "claudeAgent", { ready: false })])).toBeNull();
    expect(stand([])).toBeNull();
  });

  it("is the best ready AI, waiting on its test, and works once it answered", () => {
    expect(stand([ai("grok", "grokAgent"), ai("claude", "claudeAgent")])).toEqual({ id: "claude", state: "testing" });
    expect(stand([ai("grok", "grokAgent"), ai("claude", "claudeAgent", { aiTest: "testing" })])).toEqual({ id: "claude", state: "testing" });
    expect(stand([ai("grok", "grokAgent"), ai("claude", "claudeAgent", { aiTest: "passed" })])).toEqual({ id: "claude", state: "passed" });
    // An AI with nothing to test it with is trusted, as before.
    expect(stand([ai("muse", "museCode", { aiTest: "untestable" })])).toEqual({ id: "muse", state: "untestable" });
    // Only those two let the welcome leave out its Connect an AI step.
    expect(["passed", "untestable", "testing", "failed"].map((state) => aiWorks({ state: state as Ai["aiTest"] & string }))).toEqual([true, true, false, false]);
    expect(aiWorks(null)).toBe(false);
  });

  it("walks past an AI that didn't answer to the next, and says so when none is left", () => {
    expect(stand([ai("grok", "grokAgent", { aiTest: "passed" }), ai("claude", "claudeAgent", { aiTest: "failed" })])).toEqual({ id: "grok", state: "passed" });
    expect(stand([ai("grok", "grokAgent"), ai("claude", "claudeAgent", { aiTest: "failed" })])).toEqual({ id: "grok", state: "testing" });
    expect(stand([ai("claude", "claudeAgent", { aiTest: "failed" }), ai("opencodeGo", "opencodeGo", { snapshot: { freeFallback: true } })]))
      .toEqual({ id: "claude", state: "failed" });
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

  it("marks a first run as the one that met the Chief, keeping every hint already seen", () => {
    const now = new Date("2026-10-27T12:00:00.000Z");
    expect(firstRunPatch(undefined, now)).toEqual({ onboarding: { completedAt: now.toISOString(), version: WELCOME_VERSION, hintsSeen: [MET_CHIEF_HINT] } });
    expect(firstRunPatch({ ...EMPTY_ONBOARDING, hintsSeen: [ONBOARDING_CLOUD_HINT] }, now).onboarding.hintsSeen).toEqual([ONBOARDING_CLOUD_HINT, MET_CHIEF_HINT]);
    expect(firstRunPatch({ ...EMPTY_ONBOARDING, hintsSeen: [MET_CHIEF_HINT] }, now).onboarding, "already met").toEqual({ completedAt: now.toISOString(), version: WELCOME_VERSION });
    expect(completionPatch(now).onboarding, "a replay says nothing about a first chat").not.toHaveProperty("hintsSeen");
  });
});

describe("the first run's screens", () => {
  it("is two screens, meeting the app and then the Chief of Staff, whatever this computer has", () => {
    expect(beatsFor({})).toEqual(["meet", "chief"]);
    expect(beatsFor({ hosted: false })).toEqual(["meet", "chief"]);
  });

  it("gives a hosted place's admin only the first: their team's bots and Chief are set up already", () => {
    expect(beatsFor({ hosted: true })).toEqual(["meet"]);
  });

  it("resumes the saved screen while it is offered, else starts at the first", () => {
    expect(resumeBeat(beatsFor({}), "chief")).toBe("chief");
    expect(resumeBeat(beatsFor({}), undefined)).toBe("meet");
    expect(resumeBeat(beatsFor({ hosted: true }), "chief")).toBe("meet");
    expect(resumeBeat(beatsFor({}), "engines" as never), "a step from the longer welcome").toBe("meet");
  });
});

describe("the onboarding record's Cloud mark", () => {
  it("still tells a later Cloud pitch that an earlier welcome offered the Cloud", () => {
    expect(ONBOARDING_CLOUD_HINT).toBe("onboarding-cloud-v1");
    expect(onboardingCloudOffered(undefined)).toBe(false);
    expect(onboardingCloudOffered({ ...done, hintsSeen: ["tour-switcher"] })).toBe(false);
    expect(onboardingCloudOffered({ ...done, hintsSeen: ["tour-switcher", ONBOARDING_CLOUD_HINT] })).toBe(true);
  });
});

describe("welcomeOnScreen", () => {
  it("knows while the welcome is on screen, however often it mounts and unmounts", () => {
    expect(welcomeOnScreen()).toBe(false);
    const first = showWelcome(), second = showWelcome();
    expect(welcomeOnScreen()).toBe(true);
    first(); first();
    expect(welcomeOnScreen(), "a second hide of the same mount changes nothing").toBe(true);
    second();
    expect(welcomeOnScreen()).toBe(false);
  });
});

describe("welcomeFinishedThisLaunch", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("remembers in memory that the welcome finished when browser storage is blocked", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(() => markWelcomeFinished()).not.toThrow();
    expect(welcomeFinishedThisLaunch()).toBe(true);
  });
});
