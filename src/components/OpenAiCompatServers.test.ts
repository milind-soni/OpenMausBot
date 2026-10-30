import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "@/state/store";
import { modelIds, OtherOpenAiCompatServers, LmStudioServer, lmStudioBaseUrl } from "./OpenAiCompatServers";

const fixture = vi.hoisted(() => ({ counting: false, values: [] as unknown[], index: 0, api: vi.fn(), track: vi.fn() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!fixture.counting) return react.useState(initial);
      const index = fixture.index++;
      if (!(index in fixture.values)) fixture.values[index] = initial;
      return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
    },
  };
});
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: fixture.api }));
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const instance = (instanceId: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  instanceId, driverKind: "openai-compat", displayName,
  snapshot: { state: "available" }, models: { default: "m", options: [] }, ...extra,
}) as unknown as store.InstanceInfo;

function render(instances: store.InstanceInfo[]) {
  vi.stubGlobal("window", {});
  vi.spyOn(store, "useStore").mockReturnValue({
    state: { ...store.initialState, instances },
    dispatch: vi.fn(),
    flushBotPatches: vi.fn(),
    refreshInstances: vi.fn(),
    refreshModels: vi.fn(),
  });
  return renderToStaticMarkup(createElement(OtherOpenAiCompatServers));
}

describe("other OpenAI-compatible servers", () => {
  it("lists only servers added here, by name and base URL", () => {
    const html = render([
      instance("openaiCompat", "Other (OpenAI-compatible)"),
      instance("openai", "OpenAI", { url: "https://api.openai.com/v1" }),
      instance("openai-compat-1", "Zhipu", { url: "https://open.bigmodel.cn/api/paas/v4" }),
    ]);
    expect(html).toContain("Zhipu");
    expect(html).toContain("https://open.bigmodel.cn/api/paas/v4");
    expect(html).toContain('aria-label="Remove Zhipu"');
    expect(html).not.toContain("api.openai.com");
    expect(html).not.toContain('aria-label="Remove OpenAI"');
  });

  it("says so when none are added", () => {
    const html = render([instance("openaiCompat", "Other (OpenAI-compatible)")]);
    expect(html).toContain("No other servers yet.");
  });

  it("reads model IDs separated by commas, CJK commas or spaces", () => {
    expect(modelIds("glm-4.6, glm-5，glm-4.6、qwen3 ")).toEqual(["glm-4.6", "glm-5", "qwen3"]);
    expect(modelIds("  ")).toEqual([]);
  });
});

describe("adding another OpenAI-compatible server", () => {
  const KEY = "sk-ZZtestSECRET0123456789";
  type Props = { children?: ReactNode; servers?: unknown; onChange?: (event: { target: { value: string } }) => void; onClick?: () => void; "aria-label"?: string };
  const nodes = (tree: ReactNode): Array<ReactElement<Props>> =>
    Children.toArray(tree).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  function form() {
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: [] }, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    });
    const added = nodes(OtherOpenAiCompatServers()).find((node) => node.props.servers !== undefined)!;
    fixture.counting = true;
    fixture.index = 0;
    try {
      return nodes((added.type as (props: Props) => ReactNode)(added.props));
    } finally {
      fixture.counting = false;
    }
  }
  async function add() {
    for (const [label, value] of [["Display name", "Ada's lab box"], ["Base URL", "https://ada.example.com/v1"], ["API key", KEY]] as const) {
      form().find((node) => node.props["aria-label"] === label)!.props.onChange!({ target: { value } });
    }
    form().find((node) => node.type === "button" && node.props.children && JSON.stringify(node.props.children).includes("Add server"))!.props.onClick!();
    await flush();
  }

  it.each([
    ["unverified", () => fixture.api.mockResolvedValueOnce({ instances: [] })],
    ["error", () => fixture.api.mockRejectedValueOnce(new store.ApiError(`unreachable https://ada.example.com/v1 ${KEY}`, 502, {}))],
  ])("reports one custom endpoint key save (%s), with no name, address or key", async (result, answer) => {
    fixture.values = [];
    fixture.track.mockReset();
    fixture.api.mockReset();
    answer();
    await add();
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/instances/openai-compat", expect.objectContaining({ method: "POST" }));
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "custom_endpoint", via: "settings", result }]]);
    expect(JSON.stringify(fixture.track.mock.calls)).not.toMatch(/ada|example|ZZtest|SECRET/);
  });
});

describe("how long a server may take to reply", () => {
  type Props = { children?: ReactNode; servers?: unknown; value?: unknown; onChange?: (event: { target: { value: string } }) => void; "aria-label"?: string };
  const nodes = (tree: ReactNode): Array<ReactElement<Props>> =>
    Children.toArray(tree).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
  function waitSelect(replyWaitMinutes?: number) {
    vi.stubGlobal("window", {});
    const servers = [instance("openai-compat-1", "Ollama", { url: "http://127.0.0.1:11434/v1", ...(replyWaitMinutes ? { replyWaitMinutes } : {}) })];
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: servers }, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    });
    const added = nodes(OtherOpenAiCompatServers()).find((node) => node.props.servers !== undefined)!;
    fixture.counting = true;
    fixture.index = 0;
    try {
      return nodes((added.type as (props: Props) => ReactNode)(added.props)).find((node) => node.props["aria-label"] === "How long to wait for Ollama to reply")!;
    } finally {
      fixture.counting = false;
    }
  }

  it("saves the chosen minutes for that server, and Default clears them", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    fixture.api.mockResolvedValue({ instances: [] });
    const select = waitSelect();
    expect(select.props.value).toBe("");
    select.props.onChange!({ target: { value: "20" } });
    await Promise.resolve();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/openai-compat-1", { method: "PATCH", body: JSON.stringify({ replyWaitMinutes: 20 }) });
    fixture.values = [];
    waitSelect(20).props.onChange!({ target: { value: "" } });
    await Promise.resolve();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/openai-compat-1", { method: "PATCH", body: JSON.stringify({ replyWaitMinutes: null }) });
  });

  it("shows a saved wait that is not one of the usual choices", () => {
    fixture.values = [];
    const html = JSON.stringify(waitSelect(45).props.children);
    expect(html).toContain("Wait 45 min");
  });
});

describe("LM Studio and Bionic setup", () => {
  type Props = { children?: ReactNode; onChange?: (event: { target: { value: string } }) => void; onClick?: () => void; "aria-label"?: string };
  const elementNodes = (tree: ReactNode): Array<ReactElement<Props>> =>
    Children.toArray(tree).flatMap((child) => isValidElement<Props>(child) ? [child, ...elementNodes(child.props.children)] : []);
  it("builds the loopback address from the port alone", () => {
    expect(lmStudioBaseUrl("1234")).toBe("http://127.0.0.1:1234/v1");
    expect(lmStudioBaseUrl(" 8080 ")).toBe("http://127.0.0.1:8080/v1");
    expect(lmStudioBaseUrl("0")).toBeNull();
    expect(lmStudioBaseUrl("65536")).toBeNull();
    expect(lmStudioBaseUrl("12a")).toBeNull();
  });

  it("asks only for the port and an optional token", () => {
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: [] }, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    });
    const html = renderToStaticMarkup(createElement(LmStudioServer));
    expect(html).toContain("LM Studio (Bionic)");
    expect(html).toContain("Bionic is the current LM Studio app");
    expect(html).toContain('aria-label="Port"');
    expect(html).toContain('aria-label="API token (optional)"');
    expect(html).toContain("http://127.0.0.1:1234/v1");
    expect(html).not.toContain("Display name");
    expect(html).not.toContain("Model IDs");
    expect(html).not.toContain('aria-label="Base URL"');
  });

  it("adds LM Studio with the placeholder key when the token is empty", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    fixture.track.mockReset();
    fixture.api.mockResolvedValueOnce({ instances: [] });
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: [] }, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    });
    const button = () => {
      fixture.counting = true;
      fixture.index = 0;
      try {
        return elementNodes(LmStudioServer()).find((node) => node.type === "button")!;
      } finally {
        fixture.counting = false;
      }
    };
    button().props.onClick!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/instances/openai-compat", {
      method: "POST",
      body: JSON.stringify({ displayName: "LM Studio", url: "http://127.0.0.1:1234/v1", key: "lm-studio", catalog: "lmstudio" }),
    });
    expect(JSON.stringify(fixture.track.mock.calls)).not.toContain("lm-studio");
  });

  it("sends a token the person typed", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    fixture.api.mockResolvedValueOnce({ instances: [] });
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: [] }, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    });
    const fields = () => {
      fixture.counting = true;
      fixture.index = 0;
      try {
        return elementNodes(LmStudioServer());
      } finally {
        fixture.counting = false;
      }
    };
    fields().find((node) => node.props["aria-label"] === "API token (optional)")!.props.onChange!({ target: { value: "studio-token" } });
    fields().find((node) => node.type === "button")!.props.onClick!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const body = JSON.parse(String(fixture.api.mock.calls[0][1].body)) as { key: string };
    expect(body.key).toBe("studio-token");
  });

  it("stays quiet when that port is already added", () => {
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: {
        ...store.initialState,
        instances: [instance("openai-compat-1", "LM Studio", { url: "http://127.0.0.1:1234/v1" })],
      },
      dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    });
    const html = renderToStaticMarkup(createElement(LmStudioServer));
    expect(html).toContain("This server is already added.");
    expect(html).toContain("disabled");
  });
});
