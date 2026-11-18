// @vitest-environment happy-dom
// The chat's AI sign-in card (app_settings show_card ai-sign-in): only the accounts a person signs in to, and only for
// an owner or admin.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> }, admin: true as boolean | null, team: null as object | null }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: () => {}, refreshInstances: async () => {}, refreshModels: async () => {} }),
  api: async () => ({}),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/state/team-people", async (original) => ({ ...await original<typeof import("@/state/team-people")>(), useTeamPeople: () => fixture.team }));
vi.mock("@/lib/companion-bridge", () => ({ pageIsThisComputer: () => true }));

const { RichMessageRow } = await import("./RichMessageRow");

const engine = (instanceId: string, driverKind: string, displayName: string, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName, snapshot: { state: "available", authenticated: false }, models: { default: "m", options: [] }, ...extra,
} as InstanceInfo);
const INSTANCES = [
  engine("claude", "claudeAgent", "Claude", { cliDefault: "claude" }),
  engine("codex", "codex", "Codex", { cliDefault: "codex", snapshot: { state: "available", authenticated: false, chatgptPlan: true } as InstanceInfo["snapshot"] }),
  engine("antigravity", "antigravityAgent", "Google Gemini", { cliDefault: "agy" }),
  engine("groq", "groq", "Groq", { access: "api" } as Partial<InstanceInfo>),
  engine("openai-compat-gw", "openaiCompat", "Gateway", { access: "custom" } as Partial<InstanceInfo>),
  engine("claude-bedrock-work", "claudeAgent", "Claude on Bedrock", { claudeBedrock: { awsProfile: "p", awsRegion: "us-east-1" } } as unknown as Partial<InstanceInfo>),
];
const card = { id: "m1", role: "bot", kind: "text", text: "AI sign-in", settingsCard: { id: "ai-sign-in" } } as unknown as Message;

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.state = { instances: INSTANCES, bots: [], config: {} };
  fixture.admin = true;
  fixture.team = null;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const show = async () => {
  await act(async () => { root.render(createElement(RichMessageRow, { botId: "kiwi", botName: "Kiwi", threadId: "t-kiwi", message: card })); });
  await vi.waitFor(() => expect(container.querySelector("[data-ai-sign-in], [data-admin-only], [data-settings-card]:not(:empty)")).not.toBeNull(), { timeout: 5000 }).catch(() => {});
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};
const rows = () => [...container.querySelectorAll("[data-simple-engine]")].map((row) => row.getAttribute("data-simple-engine"));

describe("the AI sign-in card in chat", () => {
  it("lists only the accounts a person signs in to: Claude, ChatGPT or Codex, Antigravity", async () => {
    await show();
    expect(container.querySelector('[data-settings-card="ai-sign-in"] [data-ai-sign-in]')).not.toBeNull();
    expect(rows()).toEqual(["claude", "codex", "antigravity"]);
    const text = container.textContent ?? "";
    for (const absent of ["Groq", "Gateway", "Bedrock", "Custom endpoint", "Keep caches warm"]) expect(text, absent).not.toContain(absent);
    expect(container.querySelector("[data-hidden-engine]")).toBeNull();
  });

  it("shows no sign-in to someone who is not an owner or admin: the admin note, or nothing on a team", async () => {
    fixture.admin = false;
    await show();
    expect(rows()).toEqual([]);
    expect(container.querySelector("[data-admin-only]")?.textContent).toBe("Only an admin of this installation can change this.");
    fixture.team = {};
    await show();
    expect(rows()).toEqual([]);
    expect(container.querySelector("[data-admin-only]")).toBeNull();
  });
});
