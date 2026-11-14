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
const { ClaudeSignIn } = await import("./ClaudeSignIn");

type Node = ReactElement<{ children?: ReactNode; onClick?: () => Promise<void>; onSubmit?: (event: { preventDefault: () => void }) => void }>;
function nodes(tree: ReactNode): Node[] {
  return Children.toArray(tree).flatMap((child) => isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []);
}
function render(props: { autoStart?: boolean; onDone?: (signedIn: boolean) => void } = {}) {
  fixture.index = 0;
  fixture.effects = [];
  return nodes(ClaudeSignIn({ instanceId: "claude", ...props }));
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const waiting = { phase: "waiting", flowId: "flow-one", authorizationUrl: "https://claude.ai/oauth/authorize?code=true", expiresAt: "2030-01-01T00:15:00.000Z" };
const [AUTH, CODE, , ERROR] = [0, 1, 2, 3];

async function startAndPaste(code: string, onDone?: (signedIn: boolean) => void) {
  render({ onDone }).find((node) => node.type === "button")!.props.onClick!();
  await flush();
  fixture.values[CODE] = code;
  render({ onDone }).find((node) => node.type === "form")!.props.onSubmit!({ preventDefault: () => {} });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.values = [];
  fixture.refreshInstances.mockResolvedValue(undefined);
  fixture.refreshModels.mockResolvedValue(undefined);
  vi.stubGlobal("window", { setTimeout, clearTimeout, ogb: { openExternal: fixture.openExternal } });
});
afterEach(() => vi.unstubAllGlobals());

it("treats a code Claude Code accepts as the sign-in: no status request after it, models refreshed, outcome reported", async () => {
  const onDone = vi.fn();
  fixture.api.mockResolvedValueOnce({ auth: waiting }).mockResolvedValueOnce({ ok: true });
  await startAndPaste(" alice-12345678 ", onDone);
  expect(fixture.openExternal).toHaveBeenCalledWith(waiting.authorizationUrl);
  expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/claude/auth/complete", { method: "POST", body: JSON.stringify({ flowId: "flow-one", code: "alice-12345678" }) });
  expect(fixture.api).toHaveBeenCalledTimes(2);
  expect(fixture.values[AUTH]).toMatchObject({ phase: "succeeded" });
  expect(fixture.refreshInstances).toHaveBeenCalled();
  expect(fixture.refreshModels).toHaveBeenCalledWith("claude");
  expect(onDone).toHaveBeenCalledWith(true);
  expect(fixture.track.mock.calls).toEqual([["engine_signed_in", { engine: "claude", method: "code" }]]);
});

it("ends the flow with Claude Code's own words when it refuses the code, and offers to try again", async () => {
  const refused = "Anthropic did not accept that code. Start sign-in again and paste the whole code it shows.";
  fixture.api.mockResolvedValueOnce({ auth: waiting }).mockRejectedValueOnce(new ApiError(refused, 500)).mockResolvedValueOnce({ auth: { ...waiting, phase: "failed" } });
  await startAndPaste("bad-12345678");
  expect(fixture.values[AUTH]).toMatchObject({ phase: "failed", message: refused });
  expect(JSON.stringify(render().filter((node) => node.type === "button").map((node) => node.props.children))).toContain("Try again");
  expect(fixture.track).not.toHaveBeenCalled();
});

it("keeps the flow open after a code Claude Code never took, so a typo can be fixed", async () => {
  fixture.api.mockResolvedValueOnce({ auth: waiting })
    .mockRejectedValueOnce(new ApiError("Paste the whole code shown on Anthropic's page after signing in.", 500))
    .mockResolvedValueOnce({ auth: waiting });
  await startAndPaste("half-a-code");
  expect(fixture.values[AUTH]).toMatchObject({ phase: "waiting", flowId: "flow-one" });
  expect(fixture.values[ERROR]).toBe("Paste the whole code shown on Anthropic's page after signing in.");
  expect(fixture.track).not.toHaveBeenCalled();
});

it("reports no sign-in when the person cancels or the code expires", async () => {
  fixture.api.mockResolvedValueOnce({ auth: waiting }).mockResolvedValueOnce({});
  render().find((node) => node.type === "button")!.props.onClick!();
  await flush();
  const cancel = render().filter((node) => node.type === "button").find((node) => JSON.stringify(node.props.children).includes("Cancel"))!;
  await cancel.props.onClick!();
  await flush();
  expect(fixture.values[AUTH]).toBeNull();
  fixture.values[AUTH] = { ...waiting, expiresAt: "2000-01-01T00:00:00.000Z" };
  render();
  fixture.effects.forEach((effect) => effect());
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(fixture.values[AUTH]).toMatchObject({ phase: "expired" });
  expect(fixture.track).not.toHaveBeenCalled();
});

it("starts once on its own when asked, even if its effects run twice", async () => {
  fixture.api.mockResolvedValue({ auth: waiting });
  render({ autoStart: true });
  const effects = [...fixture.effects];
  effects.forEach((effect) => effect());
  effects.forEach((effect) => effect());
  await flush();
  expect(fixture.api.mock.calls.filter(([path]) => path === "/api/instances/claude/auth/start")).toHaveLength(1);
  expect(fixture.openExternal).toHaveBeenCalledOnce();
});
