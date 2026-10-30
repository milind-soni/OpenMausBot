// @vitest-environment happy-dom
// The first run: two screens, then the chat. Meeting the app (and connecting an AI when none works), then the Chief of
// Staff over the app; what it saves, where it lands, and what a reload or a replay does.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { introStaged, stageIntro, useChiefStepOpen } from "@/lib/default-bot";
import { setLocale } from "@/lib/i18n";
import { CLOUD_PRO_UPDATE_NOTICE } from "@/lib/notices";
import { EMPTY_ONBOARDING, MET_CHIEF_HINT, WELCOME_VERSION } from "@/lib/onboarding";
import { saveWelcomeDraft } from "@/lib/welcome-draft";
import type { InstanceInfo } from "@/state/store";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn(), api: vi.fn(), landed: vi.fn(), onDone: vi.fn(),
  checks: [] as string[] }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: f.api }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), setEmailGateDone: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));
vi.mock("@/components/mascot-clock", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/components/EngineSetup", async (original) => {
  const { createElement: h } = await import("react");
  return { ...(await original<typeof import("@/components/EngineSetup")>()),
    EngineSetup: ({ instance }: { instance: InstanceInfo }) => h("div", { "data-engine-setup": instance.instanceId }) };
});
vi.mock("@/lib/default-bot", async (original) => ({ ...(await original<typeof import("@/lib/default-bot")>()), useViewerEmail: () => null }));
vi.mock("@/lib/mausbot-landing", () => ({ FLIGHT_MS: 700, landInSidebar: (input: { botId: string; commit: () => void }) => { f.landed(input.botId); input.commit(); } }));
const { WelcomeFlow } = await import("./WelcomeFlow");
const { CHIEF_FADE_MS, CHIEF_GUARD_MS } = await import("./ChiefIntro");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const claude = (ready: boolean, aiTest?: InstanceInfo["aiTest"]): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready }, models: { default: "m", options: [] }, ...(aiTest ? { aiTest } : {}),
});
const freeOpenCode: InstanceInfo = {
  instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode", install: { docsUrl: "https://example.test" },
  snapshot: { state: "available", authenticated: true, freeFallback: true }, models: { default: "opencode/big-pickle", options: [] }, aiTest: "passed",
};
const signIn = (): InstanceInfo => ({ ...claude(false), snapshot: { state: "available", authenticated: false }, authentication: { method: "paste-code" } } as InstanceInfo);
const maus = { id: "maus", threadId: "t", name: "MausBot", title: "", description: "", notifications: true, color: "chrome", unread: false,
  modelSelection: { instanceId: "claude", model: "m" }, messages: [], defaultBot: {}, chiefOfStaff: true };

let host: HTMLDivElement, root: Root;
let chiefStep = false;
function Watch() {
  chiefStep = useChiefStepOpen();
  return null;
}
const text = () => host.textContent ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label);
const press = async (label: string) => { await act(async () => { button(label)!.click(); }); };
const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
const key = async (name: string) => {
  const screen = host.querySelector<HTMLElement>("[data-welcome]")!;
  await act(async () => { screen.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })); });
};
const show = async (extra: Record<string, unknown> = {}) => {
  await act(async () => { root.render([createElement(Watch, { key: "w" }), createElement(WelcomeFlow, { key: "f", onDone: f.onDone, ...extra })]); });
};
/** Next, the first screen's 100 ms fade, and the Chief dialog's input guard. */
const toChief = async (label = "Next") => {
  await press(label);
  await tick(100);
  await tick(CHIEF_GUARD_MS);
};
const saved = () => f.api.mock.calls.filter(([path, init]) => path === "/api/config" && init?.method === "PUT").map(([, init]) => JSON.parse(init.body));
const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, String(v)), removeItem: (k: string) => void values.delete(k), clear: () => values.clear() };
};

beforeEach(() => {
  vi.useFakeTimers();
  HTMLElement.prototype.animate = vi.fn(() => ({ onfinish: null, oncancel: null, cancel() {} }) as unknown as Animation);
  setLocale("en");
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  f.dispatch.mockReset();
  f.landed.mockReset();
  f.onDone.mockReset();
  f.api.mockReset();
  f.checks = [];
  f.api.mockImplementation(async (path: string, init?: { body?: string }) => {
    if (path.endsWith("/check")) { f.checks.push(path); return { ok: true }; }
    return path === "/api/instances" ? { instances: f.state.instances } : JSON.parse(init?.body ?? "{}");
  });
  f.state = { instances: [claude(true)], config: { onboarding: EMPTY_ONBOARDING, profile: { name: "" } }, bots: [maus], cloudAdd: null };
  stageIntro(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a new install's first run", () => {
  it("is two screens with an AI already working: Next, then Create, and it lands in the Chief's chat", async () => {
    await show();
    expect(host.querySelector("h1")?.textContent).toBe("Meet MausBot");
    expect(host.querySelector("[data-demo-composer]")?.textContent, "reduced motion shows the whole sentence").toContain("Hand off any task to your team of bots");
    for (const gone of ["Step 1", "Back", "Skip", "Your name", "Connect an AI", "Set up later"]) expect(text()).not.toContain(gone);
    expect(button("Next")!.disabled).toBe(false);

    await press("Next");
    expect(host.querySelector("[data-welcome]")?.getAttribute("data-welcome"), "the first screen fades out first").toBe("meet");
    await tick(100);
    expect(host.querySelector("[role=dialog]")?.textContent).toContain("Introducing your Chief of Staff");
    expect(host.querySelector("[data-welcome]")!.className).toContain("ui-scrim");
    expect(chiefStep, "the app behind it is the empty shell").toBe(true);
    expect(button("Choose an existing bot"), "no bots of the person's own yet").toBeUndefined();

    await tick(CHIEF_GUARD_MS);
    await press("Create Chief of Staff");
    expect(f.landed).toHaveBeenCalledWith("maus");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "maus", patch: { welcomed: true } });
    await tick(CHIEF_FADE_MS);
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith("maus");
    expect(introStaged("maus"), "its first messages arrive one at a time").toBe(true);
    await act(async () => {});
    expect(saved()).toEqual([{ onboarding: expect.objectContaining({ version: WELCOME_VERSION, hintsSeen: [MET_CHIEF_HINT] }) }]);
  });

  it("counts an AI once it answered one tiny test message, and never before", async () => {
    await show();
    expect(f.checks).toEqual(["/api/instances/claude/check"]);
    expect(button("Next")!.disabled).toBe(false);
    expect(host.querySelector("[data-sign-in]")).toBeNull();
  });

  it("comes back to the second screen after a reload there", async () => {
    saveWelcomeDraft({ beat: "chief" });
    await show();
    expect(text()).toContain("Introducing your Chief of Staff");
  });
});

describe("the Chief step", () => {
  const finishesAtNext = async () => {
    await show();
    await press("Next");
    await tick(100);
    expect(text()).not.toContain("Introducing your Chief of Staff");
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith(null);
    expect(chiefStep).toBe(false);
  };

  it("is skipped once MausBot has met the person", async () => {
    f.state = { ...f.state, bots: [{ ...maus, welcomed: true }] };
    await finishesAtNext();
  });

  it("is skipped where another bot is already the Chief", async () => {
    f.state = { ...f.state, bots: [{ ...maus, chiefOfStaff: false }, { ...maus, id: "research", threadId: "r", name: "Research", defaultBot: undefined, chiefOfStaff: true }] };
    await finishesAtNext();
  });

  it("is skipped where there is no MausBot", async () => {
    f.state = { ...f.state, bots: [] };
    await finishesAtNext();
  });
});

describe("the Cloud Pro popup", () => {
  const desktop = (extra: Record<string, unknown> = {}) => {
    const seen = vi.fn(async () => {});
    vi.stubGlobal("ogb", { remoteClient: { active: false }, cloudAccount: { offer: vi.fn() }, desktopNotices: { seen }, ...extra });
    return seen;
  };

  it("is settled by a first run on a desktop that could offer the Cloud, so it never follows on the next launch", async () => {
    const seen = desktop();
    await show();
    await toChief();
    await press("Create Chief of Staff");
    await tick(CHIEF_FADE_MS);
    await act(async () => {});
    expect(seen).toHaveBeenCalledWith(CLOUD_PRO_UPDATE_NOTICE);
    expect(saved()[0].onboarding.hintsSeen).toEqual([MET_CHIEF_HINT, CLOUD_PRO_UPDATE_NOTICE]);
    expect(localStorage.getItem(CLOUD_PRO_UPDATE_NOTICE)).toBe("1");
  });

  it("is left alone where the Cloud is never offered, and by a replay", async () => {
    const seen = desktop({ cloudAccount: undefined });
    await show();
    await toChief();
    await press("Create Chief of Staff");
    await tick(CHIEF_FADE_MS);
    await act(async () => {});
    expect(seen).not.toHaveBeenCalled();
    expect(saved()[0].onboarding.hintsSeen).toEqual([MET_CHIEF_HINT]);
  });
});

describe("with no AI working yet", () => {
  it("keeps the screen's shape: the pill signs in, and the line under it offers other ways or later", async () => {
    f.state = { ...f.state, instances: [signIn()] };
    await show();
    expect(host.querySelector("h1")?.textContent).toBe("Meet MausBot");
    expect(button("Next")).toBeUndefined();
    expect(button("Sign in with Claude")).toBeDefined();
    expect(button("Other ways to connect")).toBeDefined();
    expect(host.querySelector("[data-engine-setup]"), "no setup card on the screen itself").toBeNull();
    await toChief("Set up later");
    expect(text()).toContain("Introducing your Chief of Staff");
  });

  it("opens every other way in the Connect an AI dialog, where OpenCode's free model is only a backup", async () => {
    f.state = { ...f.state, instances: [freeOpenCode, claude(false)] };
    await show();
    expect(button("Connect Claude"), "an AI set up in Terminal opens the dialog").toBeDefined();
    expect(f.checks).toEqual([]);
    await press("Other ways to connect");
    const dialog = host.querySelector("[data-connect-ai]")!;
    expect(dialog.textContent).toContain("Connect an AI");
    expect(dialog.textContent).toContain("OpenCode's free model is ready as a backup");
    expect(dialog.querySelector('[data-engine-setup="claude"]')).not.toBeNull();
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.querySelector("[data-connect-ai]")).toBeNull();
    expect(text(), "Escape closed the dialog only").toContain("Meet MausBot");
  });

  it("says why an AI didn't answer its test, under the pill and in the dialog with Check again", async () => {
    f.state = { ...f.state, instances: [freeOpenCode, claude(true, "failed")] };
    await show();
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Claude");
    await press("Other ways to connect");
    expect(host.querySelector("[data-connect-ai] [data-ai-silent]")).not.toBeNull();
  });

  it("leaves the AI out for one that answered the server's own test", async () => {
    f.state = { ...f.state, instances: [freeOpenCode, claude(true, "passed")] };
    await show();
    expect(button("Next")!.disabled).toBe(false);
    expect(f.checks).toEqual([]);
  });

  it("doesn't count an AI that offers no model yet, such as OpenCode still listing its models", async () => {
    f.state = { ...f.state, instances: [{ ...freeOpenCode, snapshot: { state: "available", authenticated: true }, models: { default: "", options: [] }, aiTest: undefined }, claude(false)] };
    await show();
    expect(button("Next")).toBeUndefined();
    expect(f.checks).toEqual([]);
  });

  it("turns the pill into Next once the AI connects, with the confirmation above it", async () => {
    f.state = { ...f.state, instances: [claude(false)] };
    await show();
    f.state = { ...f.state, instances: [claude(true)] };
    await show();
    await act(async () => {});
    expect(text()).toContain("Connected to Claude");
    expect(button("Next")!.disabled).toBe(false);
    expect(button("Set up later")).toBeUndefined();
  });

  it("moves on with Escape, and Enter presses the pill, never past an AI still to connect", async () => {
    f.state = { ...f.state, instances: [claude(false)] };
    await show();
    await key("Enter");
    expect(host.querySelector("[data-connect-ai]"), "Enter pressed Connect Claude").not.toBeNull();
    expect(text()).toContain("Meet MausBot");
    await act(async () => { host.querySelector("[data-connect-ai]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await key("Escape");
    await tick(100);
    expect(text()).toContain("Introducing your Chief of Staff");
  });
});

describe("other first runs", () => {
  it("gives a hosted place's admin the first screen only, then the chat", async () => {
    await show({ hosted: true });
    expect(text()).toContain("This is your team's shared MausBot");
    await press("Next");
    expect(text()).not.toContain("Introducing your Chief of Staff");
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("a replay from Settings records nothing about a first chat", async () => {
    f.state = { ...f.state, config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01T00:00:00.000Z", version: WELCOME_VERSION } } };
    await show({ replay: true });
    await toChief();
    await press("Create Chief of Staff");
    await tick(CHIEF_FADE_MS);
    await act(async () => {});
    expect(saved()[0].onboarding).not.toHaveProperty("hintsSeen");
    expect(introStaged("maus"), "a replay lands in a chat that may be long under way").toBe(false);
  });
});
