import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "sk-ant-api03-ZZtestSECRET0123456789";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, refs: [] as Array<{ current: unknown }>, refIndex: 0,
  api: vi.fn(), dispatch: vi.fn(), track: vi.fn(), config: {} as Record<string, unknown>,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
  useId: () => "row",
  useRef: (current: unknown) => {
    const index = fixture.refIndex++;
    fixture.refs[index] ??= { current };
    return fixture.refs[index];
  },
}));
vi.mock("@/state/store", async (original) => {
  const store = await original<typeof import("@/state/store")>();
  return { ...store, api: fixture.api, useStore: () => ({ state: { ...store.initialState, config: fixture.config, instances: [] }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));
const { ApiError } = await import("@/state/store");
const { KeyRow } = await import("./KeyRow");

type Props = { children?: ReactNode; type?: string; onChange?: (event: { target: { value: string } }) => void; onKeyDown?: (event: { key: string; preventDefault: () => void }) => void; onClick?: () => void; "data-key-remove"?: boolean };
function nodes(tree: ReactNode): Array<ReactElement<Props>> {
  return Children.toArray(tree).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
}
function render(props: Parameters<typeof KeyRow>[0]) {
  fixture.index = 0;
  fixture.refIndex = 0;
  return nodes(KeyRow(props));
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const input = (tree: Array<ReactElement<Props>>) => tree.find((node) => node.type === "input")!;

async function enterKey(props: Parameters<typeof KeyRow>[0]) {
  input(render(props)).props.onChange!({ target: { value: KEY } });
  input(render(props)).props.onKeyDown!({ key: "Enter", preventDefault: () => {} });
  await flush();
}

function expectNoKeyIn(calls: unknown) {
  const sent = JSON.stringify(calls);
  for (const fragment of [KEY, KEY.slice(0, 6), KEY.slice(-6), KEY.slice(-4), String(KEY.length), "SECRET"]) expect(sent).not.toContain(fragment);
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.values = [];
  fixture.refs = [];
  fixture.config = { anthropic: { configured: false }, box: { configured: false } };
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { activeElement: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("a key saved in Settings → API keys", () => {
  it.each([
    ["ok", { ok: true, check: "authentication" }],
    ["rejected", { ok: false, reason: "rejected" }],
    ["unverified", { ok: false, reason: "unreachable" }],
  ])("reports one save whose result is the key test's verdict (%s), and never the key", async (result, verdict) => {
    fixture.api.mockResolvedValueOnce({ ...fixture.config, anthropic: { configured: true, last4: KEY.slice(-4) } }).mockResolvedValueOnce(verdict);
    await enterKey({ id: "anthropic" });
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(["/api/config", "/api/keys/test"]);
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "anthropic", via: "settings", result }]]);
    expectNoKeyIn(fixture.track.mock.calls);
  });

  it("still reports the verdict when typing again made the row stop showing it", async () => {
    let answer!: (value: unknown) => void;
    fixture.api.mockResolvedValueOnce({ anthropic: { configured: true } }).mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    await enterKey({ id: "anthropic" });
    answer({ ok: true });
    await flush();
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "anthropic", via: "settings", result: "ok" }]]);
  });

  it("reports a refused save as an error even when the server's words echo the key", async () => {
    fixture.api.mockRejectedValueOnce(new ApiError(`Invalid key ${KEY}`, 400, { error: `Invalid key ${KEY}` }));
    await enterKey({ id: "anthropic" });
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "anthropic", via: "settings", result: "error" }]]);
    expectNoKeyIn(fixture.track.mock.calls);
  });

  it("reports a Boat key boat.dev refused over the desktop bridge as rejected, from the Computer panel", async () => {
    const setCredential = vi.fn().mockRejectedValue(new Error(`Error invoking remote method 'credential:set': KeyRejected: That doesn't look like a Boat API key: ${KEY.slice(0, 12)}`));
    vi.stubGlobal("window", { ogb: { setCredential } });
    await enterKey({ id: "box", via: "computer_panel" });
    expect(setCredential).toHaveBeenCalledWith("boxToken", KEY);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "boat", via: "computer_panel", result: "rejected" }]]);
    expectNoKeyIn(fixture.track.mock.calls);
  });

  it("reports a Boat key the server checked as ok, without testing it again", async () => {
    fixture.api.mockResolvedValueOnce({ box: { configured: true } });
    await enterKey({ id: "box" });
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "boat", via: "settings", result: "ok" }]]);
  });

  it("saves an xAI key through the desktop's encrypted store, so Remove clears the stored copy too", async () => {
    const setCredential = vi.fn().mockResolvedValue({ xai: { configured: true } });
    vi.stubGlobal("window", { ogb: { setCredential } });
    fixture.api.mockResolvedValue({ ok: true });
    await enterKey({ id: "xai" });
    expect(setCredential).toHaveBeenCalledWith("xaiApiKey", KEY);
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(["/api/keys/test"]);
  });

  it("reports a removed key as removed, once, and a failed remove not at all", async () => {
    fixture.config = { anthropic: { configured: true, last4: "6789" } };
    fixture.api.mockRejectedValueOnce(new ApiError("busy", 409, { error: "busy" })).mockResolvedValueOnce({ anthropic: { configured: false } });
    const remove = () => render({ id: "anthropic" }).find((node) => node.type === "button" && node.props["data-key-remove"])!;
    remove().props.onClick!();
    await flush();
    expect(fixture.track).not.toHaveBeenCalled();
    remove().props.onClick!();
    remove().props.onClick!();
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(fixture.track.mock.calls).toEqual([["api_key_removed", { provider: "anthropic", via: "settings" }]]);
  });

  it("offers Remove for a Composio project key of the person's own, and none for the managed connection", async () => {
    const remove = () => render({ id: "composio" }).find((node) => node.type === "button" && node.props["data-key-remove"]);
    fixture.config = { composio: { configured: true, mode: "managed" } };
    expect(remove()).toBeUndefined();
    fixture.config = { composio: { configured: true, mode: "self-hosted" } };
    fixture.api.mockResolvedValue({ composio: { configured: true, mode: "managed" } });
    remove()!.props.onClick!();
    await flush();
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(fixture.track.mock.calls).toEqual([["api_key_removed", { provider: "composio", via: "settings" }]]);
    fixture.config = { composio: { configured: true, mode: "managed" } };
    expect(remove()).toBeUndefined();
  });
});
