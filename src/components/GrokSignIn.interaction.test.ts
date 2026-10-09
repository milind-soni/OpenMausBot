// Grok Build's sign-in card, driven like a person would: start, see the code,
// cancel or fail, and try again, against the engine's own auth routes.
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as (() => (() => void) | undefined)[],
  api: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(), openExternal: vi.fn(),
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
  useStore: () => ({ refreshInstances: fixture.refreshInstances, refreshModels: fixture.refreshModels }),
}));
const { DeviceSignIn } = await import("./DeviceSignIn");

type Node = ReactElement<{ children?: ReactNode; onClick?: () => Promise<void>; "data-device-sign-in"?: string }>;
function nodes(tree: ReactNode): Node[] {
  return Children.toArray(tree).flatMap((child) => isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []);
}
const text = (tree: ReactNode): string => Children.toArray(tree).map((child) =>
  typeof child === "string" || typeof child === "number" ? String(child) : isValidElement(child) ? text((child as Node).props.children) : "").join("");
function render() {
  fixture.index = 0;
  fixture.effects = [];
  return nodes(DeviceSignIn({ instanceId: "grok", provider: "grok" }));
}
const button = () => render().find((node) => node.type === "button")!;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const waiting = {
  phase: "waiting", flowId: "grok-flow", authorizationUrl: "https://accounts.x.ai/device", userCode: "WDJB-MJHT",
  expiresAt: "2030-01-01T00:15:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  vi.clearAllMocks();
  fixture.values = [];
  setLocale("en");
  vi.stubGlobal("window", { setTimeout, clearTimeout, ogb: { openExternal: fixture.openExternal } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("starts only on request on Grok's own route, and never opens a page on the person's behalf", async () => {
  expect(render()[0]!.props["data-device-sign-in"]).toBe("grok");
  expect(text(button())).toContain("Sign in to Grok");
  expect(fixture.api).not.toHaveBeenCalled();
  fixture.api.mockResolvedValueOnce({ auth: waiting }).mockResolvedValueOnce({ auth: { ...waiting, phase: "succeeded" } });
  await button().props.onClick!();
  await flush();
  expect(fixture.api).toHaveBeenCalledWith("/api/instances/grok/auth/start", { method: "POST" });
  expect(fixture.openExternal).not.toHaveBeenCalled();
  expect(fixture.values[0]).toMatchObject({ phase: "waiting", userCode: "WDJB-MJHT" });
  render();
  const cleanup = fixture.effects.at(-1)!();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(fixture.api).toHaveBeenCalledWith("/api/instances/grok/auth/status?flowId=grok-flow", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(fixture.refreshInstances).toHaveBeenCalledOnce();
  expect(fixture.refreshModels).toHaveBeenCalledWith("grok");
  cleanup?.();
});

it("cancels the same flow, then offers one action: try again", async () => {
  fixture.api.mockResolvedValueOnce({ auth: waiting }).mockResolvedValueOnce({ ok: true });
  await button().props.onClick!();
  await flush();
  expect(text(button())).toContain("Cancel sign-in");
  await button().props.onClick!();
  await flush();
  expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/grok/auth/cancel", { method: "POST", body: JSON.stringify({ flowId: "grok-flow" }) });
  expect(fixture.values[0]).toMatchObject({ phase: "cancelled", flowId: null });
  const buttons = render().filter((node) => node.type === "button");
  expect(buttons).toHaveLength(1);
  expect(text(buttons[0])).toContain("Try again");
});

it("shows a failed start in one line and offers to try again", async () => {
  fixture.api.mockRejectedValueOnce(new Error("Grok is not installed on this server. Install it with xAI's installer (https://x.ai/cli), then try again."));
  await button().props.onClick!();
  await flush();
  const tree = render();
  expect(tree.filter((node) => node.type === "button").map(text)).toEqual([expect.stringContaining("Try again")]);
  expect(text(tree.find((node) => (node.props as { role?: string }).role === "alert"))).toContain("Grok is not installed on this server.");
  fixture.api.mockResolvedValueOnce({ auth: waiting });
  await button().props.onClick!();
  await flush();
  expect(fixture.api).toHaveBeenCalledTimes(2);
  expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/grok/auth/start", { method: "POST" });
});
