import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "@/state/store";
import { BuiltInReplyWait, modelIds, OtherOpenAiCompatServers, LmStudioServer, lmStudioBaseUrl } from "./OpenAiCompatServers";
import { Select } from "./Select";

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

  it("fills in Google Gemini, so only the AI Studio key is left to paste", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    fixture.api.mockResolvedValueOnce({ instances: [] });
    const button = (text: string) => form().find((node) => node.type === "button" && JSON.stringify(node.props.children ?? "").includes(text))!;
    expect(JSON.stringify(form().map((node) => node.props.children ?? ""))).not.toContain("aistudio.google.com");
    button("Fill in Google Gemini").props.onClick!();
    expect(JSON.stringify(form().map((node) => node.props.children ?? ""))).toContain("aistudio.google.com/apikey");
    form().find((node) => node.props["aria-label"] === "API key")!.props.onChange!({ target: { value: "gemini-fixture" } });
    button("Add server").props.onClick!();
    await flush();
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/instances/openai-compat", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fixture.api.mock.calls[0][1].body)).toEqual({ displayName: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", key: "gemini-fixture" });
  });
});

describe("how long a server may take to reply", () => {
  type Props = { children?: ReactNode; servers?: unknown; value?: unknown; onChange?: (event: { target: { value: string } }) => void; onPick?: unknown; "aria-label"?: string };
  const nodes = (tree: ReactNode): Array<ReactElement<Props>> =>
    Children.toArray(tree).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
  const waitPicker = (tree: ReactNode) => {
    const picker = nodes(tree).find((node) => node.props.onPick !== undefined)!;
    return (picker.type as (props: Props) => ReactElement<Props>)(picker.props);
  };
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
      return waitPicker((added.type as (props: Props) => ReactNode)(added.props));
    } finally {
      fixture.counting = false;
    }
  }

  function builtInSelect(url: string) {
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: { openaiCompat: { url } } as unknown as store.ConfigStatus, instances: [instance("openaiCompat", "Other (OpenAI-compatible)")] },
      dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    });
    fixture.counting = true;
    fixture.index = 0;
    try {
      const tree = BuiltInReplyWait();
      return tree && waitPicker(tree);
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

  it("offers the same wait for the built-in server once its base URL is set, such as a local Ollama", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    fixture.api.mockResolvedValue({ instances: [] });
    const select = builtInSelect("http://localhost:11434/v1")!;
    expect(select.props["aria-label"]).toBe("How long to wait for Other (OpenAI-compatible) to reply");
    expect(JSON.stringify(select.props.children)).toContain("Wait 30 min");
    select.props.onChange!({ target: { value: "30" } });
    await Promise.resolve();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/openaiCompat", { method: "PATCH", body: JSON.stringify({ replyWaitMinutes: 30 }) });
    fixture.values = [];
    expect(builtInSelect("")).toBeNull();
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

describe("changing an added server's model IDs", () => {
  type Props = { children?: ReactNode; servers?: unknown; value?: unknown; onChange?: (event: { target: { value: string } }) => void; onClick?: () => void; "aria-label"?: string };
  const nodes = (tree: ReactNode): Array<ReactElement<Props>> =>
    Children.toArray(tree).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  function row(managedModels?: string[], dispatch = vi.fn()) {
    vi.stubGlobal("window", {});
    const servers = [instance("openai-compat-1", "Zhipu", { url: "https://open.bigmodel.cn/api/paas/v4", ...(managedModels ? { managedModels } : {}) })];
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: servers }, dispatch, flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
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
  const labelled = (tree: Array<ReactElement<Props>>, label: string) => tree.find((node) => node.props["aria-label"] === label);
  const save = (tree: Array<ReactElement<Props>>) => tree.find((node) => node.type === "button" && JSON.stringify(node.props.children ?? "") === JSON.stringify("Save"))!;

  it("opens the saved IDs for editing and saves the new list", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    const dispatch = vi.fn();
    const updated = [instance("openai-compat-1", "Zhipu", { managedModels: ["glm-5", "qwen3"] })];
    fixture.api.mockResolvedValue({ instances: updated });
    expect(labelled(row(["glm-4.6", "glm-5"]), "Model IDs for Zhipu")).toBeUndefined();
    labelled(row(["glm-4.6", "glm-5"]), "Change model IDs for Zhipu")!.props.onClick!();
    const field = labelled(row(["glm-4.6", "glm-5"]), "Model IDs for Zhipu")!;
    expect(field.props.value).toBe("glm-4.6, glm-5");
    field.props.onChange!({ target: { value: "glm-5，qwen3 glm-5" } });
    save(row(["glm-4.6", "glm-5"], dispatch)).props.onClick!();
    await flush();
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/instances/openai-compat-1", { method: "PATCH", body: JSON.stringify({ models: ["glm-5", "qwen3"] }) });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "instances", instances: updated });
    expect(labelled(row(["glm-5", "qwen3"]), "Model IDs for Zhipu")).toBeUndefined();
  });

  it("starts empty when the server's models are detected, and an empty list goes back to detecting them", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    fixture.api.mockResolvedValue({ instances: [] });
    labelled(row(), "Change model IDs for Zhipu")!.props.onClick!();
    expect(labelled(row(), "Model IDs for Zhipu")!.props.value).toBe("");
    save(row()).props.onClick!();
    await flush();
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/instances/openai-compat-1", { method: "PATCH", body: JSON.stringify({ models: [] }) });
  });

  it("shows the model-ID limits next to the editor instead of sending a list the server refuses", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    labelled(row(["glm-4.6"]), "Change model IDs for Zhipu")!.props.onClick!();
    labelled(row(["glm-4.6"]), "Model IDs for Zhipu")!.props.onChange!({ target: { value: Array.from({ length: 65 }, (_, i) => `m${i}`).join(" ") } });
    save(row(["glm-4.6"])).props.onClick!();
    await flush();
    expect(fixture.api).not.toHaveBeenCalled();
    const alert = row(["glm-4.6"]).find((node) => (node.props as { role?: string }).role === "alert");
    expect(alert?.props.children).toBe("Use at most 64 model IDs, each up to 200 characters.");
  });
});

describe("a server's default model", () => {
  type Props = {
    children?: ReactNode;
    servers?: unknown;
    value?: unknown;
    "aria-label"?: string;
    onChange?: (event: { target: { value: string } }) => void;
    onBlur?: (event: { target: { value: string } }) => void;
    onKeyDown?: (event: { key: string; currentTarget: { value: string }; preventDefault: () => void }) => void;
  };
  const nodes = (tree: ReactNode): Array<ReactElement<Props>> =>
    Children.toArray(tree).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
  const field = (tree: ReactNode) => nodes(tree).find((node) => node.props["aria-label"] === "Default model for Flatt");
  function server(models: { default: string; options: Array<{ id: string; label: string }> }, managedModels?: string[]) {
    vi.stubGlobal("window", {});
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, instances: [instance("openai-compat-1", "Flatt", { url: "https://flatt.example/v1", models, ...(managedModels ? { managedModels } : {}) })] },
      dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    });
    const added = nodes(OtherOpenAiCompatServers()).find((node) => node.props.servers !== undefined)!;
    return () => {
      fixture.counting = true;
      fixture.index = 0;
      try {
        return nodes((added.type as (props: Props) => ReactNode)(added.props));
      } finally {
        fixture.counting = false;
      }
    };
  }
  const options = [{ id: "automode", label: "automode" }, { id: "deepseek-v4.1-flash", label: "deepseek-v4.1-flash" }];

  it("shows the current default and saves the one picked", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    fixture.api.mockResolvedValue({ instances: [] });
    const select = field(server({ default: "automode", options })())!;
    expect(select.props.value).toBe("automode");
    select.props.onChange!({ target: { value: "deepseek-v4.1-flash" } });
    await Promise.resolve();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/openai-compat-1", { method: "PATCH", body: JSON.stringify({ model: "deepseek-v4.1-flash" }) });
  });

  it("lets a model the server did not list be typed in, then saves it", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    fixture.api.mockResolvedValue({ instances: [] });
    const draw = server({ default: "automode", options });
    const custom = nodes(field(draw()!)!.props.children as ReactNode).find((node) => node.props.children === "Custom model ID…")!;
    expect(custom).toBeDefined();
    field(draw()!)!.props.onChange!({ target: { value: custom.props.value as string } });
    const input = field(draw()!)!;
    expect(input.type).toBe("input");
    expect(input.props.value).toBe("automode");
    input.props.onChange!({ target: { value: "qwen3-coder" } });
    input.props.onKeyDown!({ key: "Enter", currentTarget: { value: "qwen3-coder" }, preventDefault: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/openai-compat-1", { method: "PATCH", body: JSON.stringify({ model: "qwen3-coder" }) });
    expect(field(draw()!)!.type).toBe(Select);
  });

  it("asks for a model ID itself when the server lists none", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    fixture.api.mockResolvedValue({ instances: [] });
    const draw = server({ default: "", options: [] });
    const input = field(draw()!)!;
    expect(input.type).toBe("input");
    input.props.onBlur!({ target: { value: "qwen3-coder" } });
    await Promise.resolve();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/instances/openai-compat-1", { method: "PATCH", body: JSON.stringify({ model: "qwen3-coder" }) });
  });

  it("offers no custom ID when config fixes the model list", () => {
    fixture.values = [];
    const draw = server({ default: "automode", options }, ["automode", "deepseek-v4.1-flash"]);
    const custom = nodes(field(draw()!)!.props.children as ReactNode).find((node) => node.props.children === "Custom model ID…");
    expect(custom).toBeUndefined();
  });

  it("says so and saves nothing for a model ID the route would refuse", async () => {
    fixture.values = [];
    fixture.api.mockReset();
    const draw = server({ default: "", options: [] });
    field(draw()!)!.props.onBlur!({ target: { value: "a\nb" } });
    await Promise.resolve();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(nodes(draw()).some((node) => node.props.children === "Enter a model ID of 1 to 200 characters, without control characters.")).toBe(true);
  });
});
