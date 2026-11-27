import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as (() => (() => void) | undefined)[],
  api: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(), openExternal: vi.fn(), track: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(fixture.values[index]) : next; }];
  },
  useEffect: (effect: () => (() => void) | undefined) => { fixture.effects.push(effect); },
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(), api: fixture.api,
  useStore: () => ({ refreshInstances: fixture.refreshInstances, refreshModels: fixture.refreshModels }),
}));
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));
const { ApiError } = await import("@/state/store");
const { DeviceSignIn } = await import("./DeviceSignIn");

type Node = ReactElement<{ children?: ReactNode; onClick?: () => Promise<void> }>;
function nodes(tree: ReactNode): Node[] {
  return Children.toArray(tree).flatMap((child) => isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []);
}
function render() {
  fixture.index = 0;
  fixture.effects = [];
  return nodes(DeviceSignIn({ instanceId: "codex", provider: "codex" }));
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const text = (node: Node) => JSON.stringify(node.props.children);
const waiting = { phase: "waiting", flowId: "flow-one", authorizationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-12345", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
const AUTH = 0;

async function startAndPoll(poll: () => Promise<unknown>) {
  render().find((node) => node.type === "button")!.props.onClick!();
  await flush();
  fixture.api.mockImplementationOnce(poll);
  render();
  fixture.effects[0]();
  await vi.advanceTimersByTimeAsync(2000);
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  fixture.values = [];
  fixture.refreshInstances.mockResolvedValue(undefined);
  fixture.refreshModels.mockResolvedValue(undefined);
  vi.stubGlobal("window", { setTimeout, clearTimeout, ogb: { openExternal: fixture.openExternal } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("shows where to turn on device code sign-in before a code is asked for", () => {
  expect(render().some((node) => node.type === "p" && text(node).includes("turn it on in ChatGPT Settings → Security"))).toBe(true);
});

it("says the sign-in was interrupted when the server no longer has it, and Try again starts a fresh one", async () => {
  fixture.api.mockResolvedValueOnce({ auth: waiting });
  await startAndPoll(() => Promise.reject(new ApiError("This sign-in is no longer available in this browser. Start a new sign-in.", 404)));
  expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/codex/auth/status?flowId=flow-one", expect.anything());
  expect(fixture.values[AUTH]).toMatchObject({ phase: "failed", message: "This sign-in was interrupted. Start again." });
  const again = render().find((node) => node.type === "button" && text(node).includes("Try again"))!;
  fixture.api.mockResolvedValueOnce({ auth: { ...waiting, flowId: "flow-two" } });
  await again.props.onClick!();
  await flush();
  expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/codex/auth/start", { method: "POST" });
  expect(fixture.values[AUTH]).toMatchObject({ phase: "waiting", flowId: "flow-two" });
});

it("says the sign-in was interrupted when the poll hears the server's interrupted reason, with no message", async () => {
  fixture.api.mockResolvedValueOnce({ auth: waiting });
  await startAndPoll(() => Promise.resolve({ auth: { phase: "failed", flowId: "flow-one", authorizationUrl: null, expiresAt: null, reason: "interrupted" } }));
  expect(fixture.values[AUTH]).toMatchObject({ phase: "failed", reason: "interrupted" });
  expect(render().some((node) => node.type === "button" && text(node).includes("Try again"))).toBe(true);
});

it("shows OpenAI's refusal as the server words it, with Try again and the setting to turn on", async () => {
  const refused = "OpenAI did not allow device code sign-in. Turn it on in ChatGPT Settings → Security (your ChatGPT admin may need to), then try again.";
  fixture.api.mockResolvedValueOnce({ auth: waiting });
  await startAndPoll(() => Promise.resolve({ auth: { phase: "failed", flowId: "flow-one", authorizationUrl: null, expiresAt: null, message: refused } }));
  expect(fixture.values[AUTH]).toMatchObject({ phase: "failed", message: refused });
  const tree = render();
  expect(tree.some((node) => node.type === "button" && text(node).includes("Try again"))).toBe(true);
  expect(tree.some((node) => node.type === "p" && text(node).includes("If OpenAI says device code sign-in isn't allowed"))).toBe(true);
});

it("ends a code that runs out with the expiry line, Try again and the setting to turn on, not endless waiting", async () => {
  fixture.api.mockResolvedValueOnce({ auth: { ...waiting, expiresAt: new Date(Date.now() + 1000).toISOString() } });
  render().find((node) => node.type === "button")!.props.onClick!();
  await flush();
  render();
  fixture.effects[0]();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.values[AUTH]).toMatchObject({ phase: "expired" });
  const tree = render();
  expect(tree.some((node) => node.type === "button" && text(node).includes("Try again"))).toBe(true);
  expect(tree.some((node) => node.type === "p" && text(node).includes("If OpenAI says device code sign-in isn't allowed"))).toBe(true);
});
