import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as (() => (() => void) | undefined)[],
  api: vi.fn(), dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(), openExternal: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
  useEffect: (effect: () => (() => void) | undefined) => { fixture.effects.push(effect); },
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(), api: fixture.api,
  useStore: () => ({ dispatch: fixture.dispatch, refreshInstances: fixture.refreshInstances, refreshModels: fixture.refreshModels }),
}));
const { DeviceSignIn } = await import("./DeviceSignIn");
const { AddProviderAccount } = await import("./CodexAccountSettings");

type Node = ReactElement<{ children?: ReactNode; onClick?: () => Promise<void> }>;
function nodes(tree: ReactNode): Node[] {
  return Children.toArray(tree).flatMap((child) => isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []);
}
function render() {
  fixture.index = 0;
  fixture.effects = [];
  return nodes(DeviceSignIn({ instanceId: "chatgpt", browserPkce: true }));
}
function click() { render().find((node) => node.type === "button")!.props.onClick!(); }
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const waiting = {
  phase: "waiting", flowId: "flow-one", authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=fixture",
  expiresAt: "2030-01-01T00:10:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  vi.clearAllMocks();
  fixture.values = [];
  vi.stubGlobal("window", { setTimeout, clearTimeout, ogb: { openExternal: fixture.openExternal } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("starts only on request, opens the official page, and refreshes models after successful polling", async () => {
  fixture.api.mockResolvedValueOnce({ auth: waiting }).mockResolvedValueOnce({ auth: { ...waiting, phase: "succeeded" } });
  render();
  fixture.effects.forEach((effect) => effect());
  expect(fixture.api).not.toHaveBeenCalled();
  click();
  await flush();
  expect(fixture.api).toHaveBeenCalledWith("/api/instances/chatgpt/auth/start", { method: "POST" });
  expect(fixture.openExternal).toHaveBeenCalledWith(waiting.authorizationUrl);
  render();
  const cleanup = fixture.effects[0]!();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(fixture.api).toHaveBeenCalledWith("/api/instances/chatgpt/auth/status?flowId=flow-one", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(fixture.refreshInstances).toHaveBeenCalledOnce();
  expect(fixture.refreshModels).toHaveBeenCalledWith("chatgpt");
  cleanup?.();
});

it("cancels the same flow and never opens an untrusted authorization URL", async () => {
  fixture.api.mockResolvedValueOnce({ auth: { ...waiting, authorizationUrl: "https://evil.test/login" } }).mockResolvedValueOnce({});
  click();
  await flush();
  expect(fixture.openExternal).not.toHaveBeenCalled();
  click();
  await flush();
  expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/chatgpt/auth/cancel", { method: "POST", body: JSON.stringify({ flowId: "flow-one" }) });
  expect(fixture.values[0]).toMatchObject({ phase: "cancelled", flowId: null });
  expect(fixture.refreshModels).not.toHaveBeenCalled();
});

it.each([undefined, "google-original"])("adds a named account independently without signing it in or replacing an existing identity (%s)", async (antigravityInstanceId) => {
  const accounts = [{ instanceId: "chatgpt-second", displayName: "Work" }];
  fixture.api.mockResolvedValueOnce({ instanceId: "chatgpt-second", instances: accounts });
  fixture.index = 0;
  nodes(AddProviderAccount({ antigravityInstanceId })).find((node) => node.type === "button")!.props.onClick!();
  fixture.index = 0;
  const input = nodes(AddProviderAccount({ antigravityInstanceId })).find((node) => node.type === "input") as ReactElement<{ onChange: (event: { target: { value: string } }) => void }>;
  input.props.onChange({ target: { value: " Work " } });
  fixture.index = 0;
  const form = nodes(AddProviderAccount({ antigravityInstanceId })).find((node) => node.type === "form") as ReactElement<{ onSubmit: (event: { preventDefault: () => void }) => void }>;
  form.props.onSubmit({ preventDefault: () => {} });
  await flush();
  expect(fixture.api).toHaveBeenCalledWith(`/api/instances/${antigravityInstanceId ? "antigravity" : "chatgpt"}-accounts`, { method: "POST", body: JSON.stringify({ displayName: "Work", ...(antigravityInstanceId ? { sourceInstanceId: antigravityInstanceId } : {}) }) });
  expect(fixture.api).toHaveBeenCalledOnce();
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "instances", instances: accounts });
  expect(fixture.openExternal).not.toHaveBeenCalled();
});
