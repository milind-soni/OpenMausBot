import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, isValidElement, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";
import { modelSwitchNeedsAsk } from "../../shared/approval-mode";
import { Select } from "./Select";
import { resolveCopilotModels } from "../../server/drivers/acp/copilot";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { instances: [] as InstanceInfo[], modelVariantSessions: {} as AppState["modelVariantSessions"], dispatch: vi.fn(),
    values: [] as unknown[], index: 0, own: 0 };
});
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
vi.mock("./MenuMotion", () => ({ useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "" }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances: fixture.instances, bots: [], modelVariantSessions: fixture.modelVariantSessions }, dispatch: fixture.dispatch,
    refreshInstances: vi.fn(() => Promise.resolve()), refreshModels: vi.fn(() => Promise.resolve()) }),
}));
const { ModelVariantRow, modelSelectionForPick } = await import("./ModelPicker");

let home: string;
let discovered: InstanceInfo["models"];
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "omb-copilot-picker-ui-"));
  discovered = await resolveCopilotModels({ HOME: home, USERPROFILE: home, PATH: dirname(process.execPath),
    FAKE_ACP_MODELS: "auto,claude-haiku-4.5,gpt-5.6-luna",
    FAKE_ACP_VARIANTS: JSON.stringify({ "gpt-5.6-luna": { id: "reasoning_effort", currentValue: "medium",
      options: [{ value: "low", name: "low" }, { value: "high", name: "high" }] } }) },
  { cli: fileURLToPath(new URL("../../server/testing/fake-acp-cli.ts", import.meta.url)) });
});
afterAll(async () => { vi.unstubAllGlobals(); if (home) await rm(home, { recursive: true, force: true }); });
beforeEach(() => {
  fixture.dispatch.mockClear(); fixture.modelVariantSessions = {};
  fixture.values = []; fixture.index = 0; fixture.own = 0;
});

const copilot = (): InstanceInfo => ({
  instanceId: "githubCopilot", displayName: "GitHub Copilot", driverKind: "copilotAgent", access: "subscription",
  snapshot: { state: "available", authenticated: true }, capabilities: { modelVariants: true }, models: discovered,
});
const claude = (): InstanceInfo => ({
  instanceId: "claude", displayName: "Claude", driverKind: "claudeAgent", access: "subscription",
  snapshot: { state: "available", authenticated: true }, models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet" }] },
});
const bot = (instanceId: string, model: string): Bot => ({
  id: "bot-hopper", threadId: "thread-hopper", name: "Hopper", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId, model },
});
type Element = ReactElement<Record<string, unknown> & { children?: ReactNode; onChange?: (event: ChangeEvent<HTMLSelectElement>) => void }>;
function elements(value: ReactNode): Element[] {
  return Children.toArray(value).flatMap((child) => isValidElement(child) ? [child as Element, ...elements((child as Element).props.children)] : []);
}

it("offers the picked Copilot model's own effort levels", () => {
  fixture.instances = [copilot()];
  const selected = bot("githubCopilot", "gpt-5.6-luna");
  const row = ModelVariantRow({ bot: selected, threadId: selected.threadId, updateBotDefault: true, compact: true });
  const select = elements(row).find((entry) => entry.type === Select)!;
  select.props.onChange!({ target: { value: "1" } } as ChangeEvent<HTMLSelectElement>);
  expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "setModel", botId: selected.id, threadId: selected.threadId,
    updateBotDefault: true, selection: { instanceId: "githubCopilot", model: "gpt-5.6-luna", variant: "high" } });
});

it("moves between Claude and Copilot without an approval reset", () => {
  fixture.instances = [claude(), copilot()];
  const toCopilot = modelSelectionForPick(bot("claude", "claude-sonnet-5").modelSelection, copilot(), "claude-haiku-4.5");
  expect(toCopilot).toEqual({ instanceId: "githubCopilot", model: "claude-haiku-4.5" });
  expect(modelSelectionForPick(toCopilot, claude(), "claude-sonnet-5")).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
  for (const mode of ["ask", "auto", "full"] as const) {
    expect(modelSwitchNeedsAsk(mode, "claudeAgent", "copilotAgent")).toBe(false);
    expect(modelSwitchNeedsAsk(mode, "copilotAgent", "customAcp")).toBe(false);
    expect(modelSwitchNeedsAsk(mode, "customAcp", "claudeAgent")).toBe(false);
    expect(modelSwitchNeedsAsk(mode, "copilotAgent", "claudeAgent")).toBe(false);
  }
});
