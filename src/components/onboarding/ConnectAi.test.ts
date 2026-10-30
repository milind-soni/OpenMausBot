// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDesktopBridge } from "../../../electron/managed-desktop.mjs";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const f = vi.hoisted(() => ({
  instances: [] as InstanceInfo[], dispatch: vi.fn(), row: null as null | { bridge: unknown; onOpenSettings: () => void },
  check: (): Promise<object> => Promise.resolve({ ok: true }), checks: [] as string[], fail: false,
}));
vi.mock("@/state/store", () => ({
  api: async (path: string) => {
    if (f.fail) { f.fail = false; throw new Error("503"); }
    if (!path.endsWith("/check")) return { instances: f.instances };
    f.checks.push(path);
    return f.check();
  },
  useStore: () => ({ state: { instances: f.instances }, dispatch: f.dispatch }),
}));
vi.mock("@/components/EngineSetup", async () => {
  const { createElement: h } = await import("react");
  return { EngineSetup: ({ instance, intent, description }: { instance: InstanceInfo; intent: string; description?: string }) =>
    h("div", { "data-engine-setup": instance.instanceId, "data-intent": intent, "data-description": description }) };
});
// The row has its own tests; here only whether the first screen offers it.
vi.mock("./beats/OrganisationRow", () => ({ OrganisationRow: (props: NonNullable<typeof f.row>) => { f.row = props; return null; } }));
const { ConnectAi, ConnectAiDialog } = await import("./ConnectAi");
const { useWelcomeAi } = await import("./welcome-ai");
const { useStore } = await import("@/state/store");

/** As the first screen has it: the AI it stands on, tested once, handed to the block. */
function FirstScreenAi({ hosted = false }: { hosted?: boolean }) {
  const { state } = useStore();
  return createElement(ConnectAi, { hosted, tested: useWelcomeAi(state.instances, !hosted) });
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const engine = (instanceId: string, driverKind: string, displayName: string, ready: boolean): InstanceInfo => ({
  instanceId, driverKind, displayName, install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready }, models: { default: "m", options: [] },
});
const bridge = { onState: vi.fn(), state: vi.fn() } as unknown as ManagedDesktopBridge;
let host: HTMLDivElement, root: Root;
const text = () => host.textContent ?? "";
const show = async (extra: { hosted?: boolean } = {}) => {
  await act(async () => { root.render(createElement(FirstScreenAi, extra)); });
};
/** Every other way is listed under the recommended one, with nothing to unfold. */
const otherWays = async () => {
  await act(async () => {});
};

beforeEach(() => {
  setLocale("en");
  f.check = () => Promise.resolve({ ok: true });
  f.checks = [];
  f.instances = [engine("grok", "grokAgent", "Grok", false), engine("claude", "claudeAgent", "Claude", false), engine("codex", "codex", "Codex", false)];
  f.dispatch.mockReset();
  f.row = null;
  f.fail = false;
  vi.stubGlobal("ogb", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("connecting an AI on the first screen", () => {
  it("says when it could not check the AIs, keeps what it already lists, and checks again", async () => {
    // Was a step of scripts/verify-onboarding-ui.ts, whose fixture no longer reaches this step (its AI already works).
    await show();
    await otherWays();
    const listed = () => [...host.querySelectorAll("[aria-expanded]")].map((node) => node.textContent);
    const before = listed();
    const checkAgain = async () => {
      const button = [...host.querySelectorAll("button")].find((node) => node.textContent === "Check again")!;
      await act(async () => { button.click(); });
    };
    f.fail = true;
    await checkAgain();
    expect(text()).toContain("Couldn't check your AI connections");
    expect(listed()).toEqual(before);
    await checkAgain();
    expect(text()).not.toContain("Couldn't check your AI connections");
  });

  it("leads with one recommended way, then lists every other way, with no status list and no engine talk", async () => {
    await show();
    expect([...host.querySelectorAll("[data-engine-setup]")].map((node) => node.getAttribute("data-engine-setup"))).toEqual(["claude"]);
    expect(host.querySelector("[data-ai-recommended]")?.getAttribute("data-ai-recommended")).toBe("claude");
    const rows = [...host.querySelectorAll("button[aria-expanded]")].map((node) => node.textContent);
    expect(rows).toHaveLength(2);
    expect(rows).toContain("Codex");
    expect(text()).not.toContain("Other ways");
    for (const word of [/\bengines?\b/i, /\bReady\b/, /Needs setup/i, /to set up/i, /provider/i]) expect(text()).not.toMatch(word);
  });

  it("says one plain line on a sign-in at the provider's website, and leaves a step finished in Terminal and a local-model setup their own words", async () => {
    const signsIn = (instance: InstanceInfo, method?: "paste-code" | "device-code"): InstanceInfo =>
      ({ ...instance, snapshot: { state: "available", authenticated: false }, ...(method ? { authentication: { method } } : {}) });
    f.instances = [
      signsIn(engine("claude", "claudeAgent", "Claude", false), "paste-code"),
      signsIn(engine("grok", "grokAgent", "Grok", false), "device-code"),
      signsIn(engine("kimi", "kimiAgent", "Kimi", false)),
      engine("codex", "codex", "Codex", false),
      { ...engine("droid", "droidAgent", "Droid", false), install: { docsUrl: "https://example.test", server: { package: "droid" } } },
      { ...engine("local", "openai-compat", "Local models", false), access: "custom" },
    ];
    const setup = (id: string) => host.querySelector(`[data-engine-setup="${id}"]`);
    const plain = (name: string) => `Use the ${name} account you already have. You sign in on their own website, so your password stays with them.`;
    await show();
    expect(setup("claude")?.getAttribute("data-description")).toBe(plain("Claude"));
    await otherWays();
    const openRow = async (name: string) => {
      const row = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) => button.textContent?.includes(name))!;
      await act(async () => { row.click(); });
    };
    await openRow("Grok");
    expect(setup("grok")?.getAttribute("data-description")).toBe(plain("Grok"));
    await openRow("Droid");
    expect(setup("droid")?.getAttribute("data-description"), "the app installs it, then the sign-in follows").toBe(plain("Droid"));
    for (const [id, name] of [["kimi", "Kimi"], ["codex", "Codex"]]) {
      await openRow(name);
      expect(setup(id)?.hasAttribute("data-description"), `${name} is finished in Terminal: its setup keeps its own instructions`).toBe(false);
    }
    await openRow("Local models");
    expect(setup("local")?.getAttribute("data-intent")).toBe("inject");
    expect(setup("local")?.hasAttribute("data-description")).toBe(false);
  });

  it("says which AI is connected once one is, and recommends nothing more", async () => {
    f.instances = [engine("claude", "claudeAgent", "Claude", true), engine("codex", "codex", "Codex", false)];
    await show();
    expect(host.querySelector("[data-ai-connected]")?.textContent).toContain("Claude");
    expect(host.querySelector("[data-ai-recommended]")).toBeNull();
    expect(text()).not.toContain("Other ways");
  });

  it("says Connected only after the AI answered a test message, and plainly while it checks", async () => {
    let answer!: (value: object) => void;
    f.check = () => new Promise((resolve) => { answer = resolve; });
    f.instances = [engine("grok", "grokAgent", "Grok", true), engine("claude", "claudeAgent", "Claude", true)];
    await show();
    expect(f.checks).toEqual(["/api/instances/claude/check"]);
    expect(host.querySelector("[data-ai-connected]")).toBeNull();
    expect(host.querySelector("[data-ai-checking]")?.textContent).toBe("Checking that Claude answers…");
    await act(async () => { answer({ ok: true }); });
    expect(host.querySelector("[data-ai-connected]")?.textContent).toBe("Connected · Claude");
    expect(host.querySelector("[data-ai-checking]")).toBeNull();
  });

  it("says a signed-in AI didn't answer, tries the next one, and keeps every other way open", async () => {
    f.check = () => Promise.resolve({ ok: false, error: "Claude didn't answer within 90 seconds." });
    f.instances = [engine("claude", "claudeAgent", "Claude", true), engine("codex", "codex", "Codex", false), engine("kimi", "kimiAgent", "Kimi", false)];
    await show();
    expect(host.querySelector("[data-ai-silent] [data-ai-reason]")?.textContent).toBe("Claude didn't answer within 90 seconds.");
    expect(host.querySelector("[data-ai-silent]")?.textContent).toContain("Or connect another AI below.");
    expect(host.querySelector("[data-ai-connected]")).toBeNull();
    expect(host.querySelector("[data-ai-recommended]")?.getAttribute("data-ai-recommended")).toBe("codex");
    await otherWays();
    expect(text()).toContain("Kimi");
    // The next ready AI gets its own test.
    f.instances = [...f.instances, engine("grok", "grokAgent", "Grok", true)];
    f.check = () => Promise.resolve({ ok: true });
    await show();
    expect(f.checks).toEqual(["/api/instances/claude/check", "/api/instances/grok/check"]);
    expect(host.querySelector("[data-ai-connected]")?.textContent).toBe("Connected · Grok");
  });

  it("says the plain reason a check gave, and Check again sends a new test message", async () => {
    f.check = () => Promise.resolve({ ok: false, error: "Claude isn't signed in on this computer anymore. Sign in again, then check again." });
    f.instances = [engine("claude", "claudeAgent", "Claude", true), engine("codex", "codex", "Codex", false)];
    await show();
    expect(host.querySelector("[data-ai-reason]")?.textContent).toBe("Claude isn't signed in on this computer anymore. Sign in again, then check again.");
    expect(text()).not.toContain("is signed in but didn't answer");
    let answer!: (value: object) => void;
    f.check = () => new Promise((resolve) => { answer = resolve; });
    const again = [...host.querySelectorAll<HTMLButtonElement>("[data-ai-silent] button")].find((button) => button.textContent === "Check again")!;
    await act(async () => { again.click(); });
    expect(f.checks).toEqual(["/api/instances/claude/check", "/api/instances/claude/check"]);
    expect(host.querySelector("[data-ai-checking]")?.textContent).toBe("Checking that Claude answers…");
    await act(async () => { answer({ ok: true }); });
    expect(host.querySelector("[data-ai-connected]")?.textContent).toBe("Connected · Claude");
  });

  it("shows what the server's own test found, without sending another", async () => {
    f.instances = [{ ...engine("claude", "claudeAgent", "Claude", true), aiTest: "failed", aiTestError: "Your Claude usage limit has been reached." },
      engine("codex", "codex", "Codex", false)];
    await show();
    expect(f.checks).toEqual([]);
    expect(host.querySelector("[data-ai-reason]")?.textContent).toBe("Your Claude usage limit has been reached.");
    // With no reason given, the plain line.
    f.instances = [{ ...engine("claude", "claudeAgent", "Claude", true), aiTest: "failed" }];
    await show();
    expect(host.querySelector("[data-ai-reason]")?.textContent).toBe("Claude is signed in but didn't answer. Try another way.");
  });

  it("asks for the person's own AI when only OpenCode's free model works, and says the free model is a backup", async () => {
    const backup: InstanceInfo = { ...engine("opencodeGo", "opencodeGo", "OpenCode", true), snapshot: { state: "available", authenticated: true, freeFallback: true } };
    f.instances = [backup, engine("claude", "claudeAgent", "Claude", false)];
    await show();
    expect(f.checks).toEqual([]);
    expect(host.querySelector("[data-ai-connected]")).toBeNull();
    expect(host.querySelector("[data-ai-backup]")?.textContent).toBe("OpenCode's free model is ready as a backup. For the best answers, connect an AI you already use.");
    expect(host.querySelector("[data-ai-recommended]")?.getAttribute("data-ai-recommended")).toBe("claude");
  });

  it("offers the organization sign-in under Other ways on this computer's own window only", async () => {
    await show();
    await otherWays();
    expect(f.row).toBeNull();
    vi.stubGlobal("ogb", { organization: bridge });
    window.ogb = { organization: bridge } as unknown as typeof window.ogb;
    await show({ hosted: true });
    expect(f.row).toBeNull();
    await show();
    expect(f.row?.bridge).toBe(bridge);
    f.row!.onOpenSettings();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "organization" });
    delete window.ogb;
  });

  it("opens as the Connect an AI dialog, which Escape and a click outside close", async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(createElement(ConnectAiDialog, { tested: null, onClose })); });
    const dialog = host.querySelector<HTMLElement>("[data-connect-ai]")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.querySelector("h2")?.textContent).toBe("Connect an AI");
    expect(dialog.querySelector("[data-ai-recommended]")).not.toBeNull();
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => { dialog.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
    await act(async () => { dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose, "a click inside stays").toHaveBeenCalledTimes(2);
  });
});
