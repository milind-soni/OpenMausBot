import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { DecisionModelSettings, deciderFailureText } from "./DecisionModelSettings";
import { Switch } from "./SettingsPrimitives";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as Array<() => unknown>,
  config: null as ConfigStatus | null,
  api: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
  useEffect: (effect: () => unknown) => { fixture.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

const KEY = "tsk_ui_secret_key_value";
type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; fixture.effects = []; tree = DecisionModelSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const byTestId = (id: string) => all.filter((node) => node.props["data-testid"] === id);
  return {
    html,
    switches: all.filter((node) => node.type === Switch),
    master: byTestId("decider-master")[0]!,
    job: byTestId("decider-job-roomRouting")[0]!,
    provider: byTestId("decider-provider")[0],
    model: byTestId("decider-model")[0],
    save: byTestId("decider-save")[0]!,
    test: byTestId("decider-test")[0]!,
    manage: byTestId("decider-manage-keys")[0],
    input: all.find((node) => node.type === "input")!,
  };
}
const click = (node: Node) => (node.props.onClick as () => void)();
const type = (node: Node, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const status = (decider: NonNullable<ConfigStatus["decider"]>) => ({ decider } as ConfigStatus);
const change = (node: Node, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const runEffects = () => { for (const effect of fixture.effects) effect(); };
const SHARED = { configured: true, keySource: "shared", sharedKey: true } as const;
const openrouter = (extra: Partial<NonNullable<ConfigStatus["decider"]>> = {}) =>
  status({ provider: "openrouter", model: "openai/gpt-4.1-nano", configured: false, enabled: false, jobs: { roomRouting: true }, ...extra });
const MODELS = {
  source: "openrouter",
  models: [
    { id: "openai/gpt-4.1-nano", name: "OpenAI: GPT-4.1 Nano", group: "recommended" },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Meta: Llama 3.3 70B Instruct", group: "recommended" },
    { id: "acme/zippy", name: "Acme: Zippy", group: "more" },
  ],
};
const optionsOf = (node: Node) => nodes(node.props.children).filter((child) => child.type === "option").map((child) => child.props.value);

beforeEach(() => {
  fixture.values = [];
  fixture.config = status({ provider: "jev", configured: false, enabled: false, jobs: { roomRouting: true } });
  fixture.api.mockReset();
  fixture.dispatch.mockReset().mockImplementation(({ config }: { config: ConfigStatus }) => { fixture.config = config; });
  vi.stubGlobal("window", {});
});

afterEach(() => vi.unstubAllGlobals());

describe("DecisionModelSettings", () => {
  it("explains itself, then the switch, the key, and what it decides", () => {
    const view = render();
    const order = ["Small, fast models that sort and read things for your bots", "Decisions: not set up · Extraction: not set up", "Cloudflare Workers AI (free tier)",
      "Use fast decisions and extraction", "Jev API key", "What it decides", "Who answers in rooms"]
      .map((text) => view.html.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(view.html).toContain("Not connected");
    expect(view.html).toContain('href="https://typesafe.ai"');
    expect(view.master.props.checked).toBe(false);
    expect(view.master.props.disabled).toBe(true);
    expect(view.html).toContain("Save a key below to turn this on.");
  });

  it("offers both providers, with Jev selected for an existing install and no model picker", () => {
    const view = render();
    expect(view.provider!.props.value).toBe("jev");
    expect(optionsOf(view.provider!)).toEqual(["jev", "openrouter"]);
    expect(view.html).toContain("TypeSafe Jev");
    expect(view.model).toBeUndefined();
    expect(fixture.effects).toHaveLength(1);
    runEffects();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("lists the coming-soon jobs with no switch", () => {
    const view = render();
    for (const label of ["Browser clicks", "Tool selection", "Where work runs"]) expect(view.html).toContain(label);
    expect(view.html.match(/Coming soon/g)).toHaveLength(3);
    expect(view.switches).toHaveLength(2);
  });

  it("every button shows a pointer cursor", () => {
    const view = render();
    for (const node of [view.save, view.test, view.master, view.job]) expect(String(node.props.className)).toContain("cursor-pointer");
  });

  it("saves the key, shows Connected, and never renders the key back", async () => {
    fixture.api.mockResolvedValueOnce(status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } }));
    type(render().input, KEY);
    click(render().save);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { key: KEY } }) });
    const view = render();
    expect(view.html).toContain("Connected");
    expect(view.html).not.toContain(KEY);
    expect(view.input.props.value).toBe("");
    expect(view.master.props.checked).toBe(true);
  });

  it("the master switch and the job switch patch the config", async () => {
    fixture.config = status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
    fixture.api.mockResolvedValue(fixture.config);
    click(render().master);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { enabled: false } }) });
    fixture.config = status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
    click(render().job);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { jobs: { roomRouting: false } } }) });
  });

  it("Test shows the result: how fast on success, a fixed sentence on failure", async () => {
    fixture.config = status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
    fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 342 });
    click(render().test);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/decider/test", { method: "POST", body: "{}" });
    expect(render().html).toContain("Jev answered in 342 ms.");

    fixture.api.mockResolvedValueOnce({ ok: false, reason: "rejected", status: 401 });
    type(render().input, "tsk_draft");
    click(render().test);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ key: "tsk_draft" }) });
    expect(render().html).toContain("Jev rejected this key. Check it at typesafe.ai.");
  });

  it("shows Cloud Pro's included decisions as included, on, with nothing to clear", () => {
    fixture.config = status({ provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } });
    const view = render();
    expect(view.html).toContain("Included with your Cloud plan");
    expect(view.html).not.toContain("Connected");
    expect(view.html).not.toContain("Not connected");
    expect(view.html).not.toContain("Save a key below to turn this on.");
    expect(view.master.props.checked).toBe(true);
    expect(view.master.props.disabled).toBe(false);
    expect(view.job.props.checked).toBe(true);
    expect(view.html).not.toContain("Clear");
    expect(view.html).not.toContain("Remove the saved key");
    expect(view.save.props.disabled).toBe(true);
    expect(view.input.props.placeholder).toBe("Paste your TypeSafe API key");
    expect(view.test.props.disabled).toBe(false);
  });

  it("with an own key saved as well, shows Connected and offers Clear, as without Cloud Pro", () => {
    fixture.config = status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
    const view = render();
    expect(view.html).toContain("Connected");
    expect(view.html).not.toContain("Included with your Cloud plan");
    expect(view.html).toContain("Clear");
    expect(view.save.props.disabled).toBe(false);
  });

  it("can be switched off, and a pasted own key is saved to replace it", async () => {
    fixture.config = status({ provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } });
    fixture.api.mockResolvedValueOnce(status({ provider: "jev", configured: true, included: true, enabled: false, jobs: { roomRouting: true } }));
    click(render().master);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { enabled: false } }) });
    expect(render().master.props.checked).toBe(false);
    click(render().save);
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    fixture.api.mockResolvedValueOnce(status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } }));
    type(render().input, KEY);
    click(render().save);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { key: KEY } }) });
    expect(render().html).toContain("Connected");
  });

  it("Test checks the included decisions, and says what a refusal from Cloud Pro means", async () => {
    fixture.config = status({ provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } });
    fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 210 });
    click(render().test);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: "{}" });
    expect(render().html).toContain("Jev answered in 210 ms.");
    for (const [result, text] of [
      [{ ok: false, reason: "http_error", status: 402 }, "Decisions are included with an active Cloud subscription."],
      [{ ok: false, reason: "rate_limited", status: 429 }, "Your Cloud plan&#x27;s decisions are busy or used up for this month. Try again later."],
      [{ ok: false, reason: "rejected", status: 401 }, "MausBot Cloud did not accept this machine&#x27;s decisions. Try again later."],
    ] as const) {
      fixture.api.mockResolvedValueOnce(result);
      click(render().test);
      await flush();
      expect(render().html).toContain(text);
      expect(render().html).not.toContain("typesafe.ai.");
    }
    fixture.api.mockResolvedValueOnce({ ok: false, reason: "rejected", status: 401 });
    type(render().input, "tsk_draft");
    click(render().test);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ key: "tsk_draft" }) });
    expect(render().html).toContain("Jev rejected this key. Check it at typesafe.ai.");
  });

  it("maps every failure to a fixed sentence", () => {
    expect(deciderFailureText({ reason: "rejected" }, false, "jev")).toBe("Jev rejected this key. Check it at typesafe.ai.");
    expect(deciderFailureText({ reason: "overloaded" })).toBe("Jev is overloaded right now. Try again shortly.");
    expect(deciderFailureText({ reason: "http_error", status: 500 })).toBe("Jev sent back an error (500). Try again in a moment.");
    expect(deciderFailureText({ reason: "something-new" })).toBe("The test did not finish. Try again.");
  });

  describe("with OpenRouter", () => {
    beforeEach(() => { fixture.config = openrouter(); });

    it("picking a provider saves it, drops a half-typed key and an old verdict", async () => {
      fixture.config = status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
      fixture.api.mockResolvedValueOnce(openrouter({ configured: false, enabled: false }));
      type(render().input, "half-typed");
      change(render().provider!, "openrouter");
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { provider: "openrouter" } }) });
      const view = render();
      expect(view.provider!.props.value).toBe("openrouter");
      expect(view.input.props.value).toBe("");
      fixture.api.mockResolvedValueOnce(status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } }));
      change(view.provider!, "jev");
      await flush();
      expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { provider: "jev" } }) });
    });

    it("shows OpenRouter's labels, key link and model picker, and not Jev's", () => {
      const view = render();
      for (const text of ["Use OpenRouter for fast decisions", "OpenRouter API key", "Get a key at openrouter.ai", "Not connected"]) expect(view.html).toContain(text);
      expect(view.html).toContain('href="https://openrouter.ai/keys"');
      expect(view.html).not.toContain("Use Jev for fast decisions");
      expect(view.html).not.toContain("typesafe.ai");
      expect(view.input.props.placeholder).toBe("Paste your OpenRouter API key");
      expect(view.model).toBeDefined();
      expect(view.master.props.disabled).toBe(true);
    });

    it("loads the model list once, in recommended and more groups, and keeps an off-list saved model", async () => {
      fixture.api.mockResolvedValue(MODELS);
      expect(optionsOf(render().model!)).toEqual(["openai/gpt-4.1-nano"]);
      runEffects();
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/decider/models");
      let view = render();
      expect(optionsOf(view.model!)).toEqual(["openai/gpt-4.1-nano", "meta-llama/llama-3.3-70b-instruct", "acme/zippy"]);
      expect(view.html).toContain("Recommended");
      expect(view.html).toContain("More models");
      expect(view.html).toContain("Meta: Llama 3.3 70B Instruct");
      expect(view.html).not.toContain("built-in list");
      runEffects();
      expect(fixture.api).toHaveBeenCalledTimes(1);
      fixture.config = openrouter({ model: "newvendor/brand-new" });
      view = render();
      expect(view.model!.props.value).toBe("newvendor/brand-new");
      expect(optionsOf(view.model!)).toEqual(["newvendor/brand-new", "openai/gpt-4.1-nano", "meta-llama/llama-3.3-70b-instruct", "acme/zippy"]);
    });

    it("says when only the built-in list could be loaded, and survives a failed load", async () => {
      fixture.api.mockResolvedValueOnce({ ...MODELS, source: "builtin" });
      render();
      runEffects();
      await flush();
      expect(render().html).toContain("OpenRouter&#x27;s model catalog could not be loaded, so this is the built-in list.");
      fixture.values = [];
      fixture.api.mockRejectedValueOnce(new Error("offline"));
      render();
      runEffects();
      await flush();
      const view = render();
      expect(optionsOf(view.model!)).toEqual(["openai/gpt-4.1-nano"]);
      expect(view.html).not.toContain("built-in list");
    });

    it("choosing a model saves it", async () => {
      fixture.api.mockResolvedValueOnce(openrouter({ model: "acme/zippy" }));
      change(render().model!, "acme/zippy");
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { openrouterModel: "acme/zippy", openrouterApi: "chat" } }) });
      expect(render().model!.props.value).toBe("acme/zippy");
    });

    it("saves the key on the server path, shows Connected and never renders the key back", async () => {
      fixture.api.mockResolvedValueOnce(openrouter({ configured: true, enabled: true }));
      type(render().input, KEY);
      click(render().save);
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { openrouterKey: KEY } }) });
      const view = render();
      expect(view.html).toContain("Connected");
      expect(view.html).not.toContain(KEY);
      expect(view.input.props.value).toBe("");
      expect(view.master.props.checked).toBe(true);
    });

    it("on the desktop the key goes to the credential store under its own name", async () => {
      const setCredential = vi.fn().mockResolvedValue(openrouter({ configured: true, enabled: true }));
      vi.stubGlobal("window", { ogb: { setCredential } });
      type(render().input, KEY);
      click(render().save);
      await flush();
      expect(setCredential).toHaveBeenCalledWith("openrouterDeciderKey", KEY);
      expect(fixture.api).not.toHaveBeenCalled();
    });

    it("Test names OpenRouter, and warns when the answer is slower than a room may wait", async () => {
      fixture.config = openrouter({ configured: true, enabled: true });
      fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 342 });
      click(render().test);
      await flush();
      expect(fixture.api).toHaveBeenCalledWith("/api/decider/test", { method: "POST", body: "{}" });
      let html = render().html;
      expect(html).toContain("OpenRouter answered in 342 ms.");
      expect(html).not.toContain("slower than");
      fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 2100 });
      click(render().test);
      await flush();
      html = render().html;
      expect(html).toContain("OpenRouter answered in 2100 ms.");
      expect(html).toContain("slower than the 1.5 s a room decision may take");
      fixture.api.mockResolvedValueOnce({ ok: false, reason: "rejected", status: 401 });
      type(render().input, "sk-or-draft");
      click(render().test);
      await flush();
      expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ key: "sk-or-draft" }) });
      expect(render().html).toContain("OpenRouter rejected this key. Check it at openrouter.ai/keys.");
    });

    describe("with the OpenRouter key from API keys", () => {
      it("uses it with nothing to enter: labelled, linked, switchable, with no key to clear", async () => {
        fixture.config = openrouter(SHARED);
        const view = render();
        expect(view.html).toContain("Using your OpenRouter API key");
        expect(view.html).toContain("Shared with your OpenRouter models");
        expect(view.html).not.toContain("Not connected");
        expect(view.html).not.toContain("Get a key at openrouter.ai");
        expect(view.html).not.toContain("Save an OpenRouter key below or under API keys");
        expect(view.master.props.disabled).toBe(false);
        expect(view.save.props.disabled).toBe(true);
        expect(view.html).not.toContain("Clear");
        expect(view.input.props.placeholder).toBe("Use a different key (optional)");
        expect(view.test.props.disabled).toBe(false);
        fixture.api.mockResolvedValueOnce(openrouter({ ...SHARED, enabled: true }));
        click(view.master);
        await flush();
        expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { enabled: true } }) });
      });

      it("links to where the key is managed", () => {
        fixture.config = openrouter(SHARED);
        fixture.dispatch.mockReset();
        click(render().manage!);
        expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleAppSettings", open: true, section: "connections" });
      });

      it("Test checks the shared key without sending one, and a pasted key still saves as the override", async () => {
        fixture.config = openrouter(SHARED);
        fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 280 });
        click(render().test);
        await flush();
        expect(fixture.api).toHaveBeenCalledWith("/api/decider/test", { method: "POST", body: "{}" });
        expect(render().html).toContain("OpenRouter answered in 280 ms with your shared key.");
        fixture.api.mockResolvedValueOnce(openrouter({ ...SHARED, keySource: "own" }));
        type(render().input, KEY);
        click(render().save);
        await flush();
        expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { openrouterKey: KEY } }) });
        expect(render().html).not.toContain(KEY);
      });

      it("a separate saved key shows as such, can be replaced or cleared, and says what clearing does", async () => {
        fixture.config = openrouter({ ...SHARED, keySource: "own", enabled: true });
        const view = render();
        expect(view.html).toContain("Connected (separate key)");
        expect(view.html).toContain("Clear this key to use your shared OpenRouter API key instead.");
        expect(view.html).not.toContain("Using your OpenRouter API key");
        expect(view.manage).toBeUndefined();
        expect(view.input.props.placeholder).toBe("••••••••  (paste to replace)");
        expect(view.html).toContain("Clear");
        expect(view.save.props.disabled).toBe(false);
        fixture.api.mockResolvedValueOnce(openrouter({ ...SHARED, enabled: true }));
        click(view.save);
        await flush();
        expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { openrouterKey: "" } }) });
        expect(render().html).toContain("Using your OpenRouter API key");
      });

      it("with no key anywhere, asks for one and points to API keys", () => {
        const view = render();
        expect(view.html).toContain("Not connected");
        expect(view.html).toContain("Save an OpenRouter key under API keys to use it here and for models");
        expect(view.html).toContain("Save an OpenRouter key below or under API keys to turn this on.");
        expect(view.manage).toBeDefined();
        expect(view.master.props.disabled).toBe(true);
        expect(view.test.props.disabled).toBe(true);
      });

      it("a separate key with nothing shared reads as plain Connected", () => {
        fixture.config = openrouter({ configured: true, keySource: "own", enabled: true });
        const view = render();
        expect(view.html).toContain("Connected");
        expect(view.html).not.toContain("separate key");
        expect(view.html).not.toContain("shared OpenRouter API key");
        expect(view.manage).toBeUndefined();
      });
    });

    it("maps every OpenRouter failure to a fixed sentence", () => {
      const text = (result: { reason: string; status?: number }) => deciderFailureText(result, false, "openrouter");
      expect(text({ reason: "rejected", status: 401 })).toBe("OpenRouter rejected this key. Check it at openrouter.ai/keys.");
      expect(text({ reason: "http_error", status: 402 })).toBe("Your OpenRouter account is out of credits. Add some at openrouter.ai/credits.");
      expect(text({ reason: "http_error", status: 500 })).toBe("OpenRouter sent back an error (500). Try again in a moment.");
      expect(text({ reason: "rate_limited" })).toBe("OpenRouter is limiting requests right now. Try again in a moment.");
      expect(text({ reason: "overloaded" })).toBe("The model is overloaded right now. Try again shortly.");
      expect(text({ reason: "malformed" })).toBe("The model sent an answer MausBot could not read. Try another model.");
      expect(text({ reason: "unreachable" })).toBe("Could not reach OpenRouter. Check your connection.");
      expect(text({ reason: "timeout" })).toBe("OpenRouter did not answer in time. Try again.");
      expect(text({ reason: "no_key" })).toBe("Paste a key or save one first.");
      expect(text({ reason: "something-new" })).toBe("The test did not finish. Try again.");
      expect(deciderFailureText({ reason: "http_error", status: 402 })).toBe("Jev sent back an error (402). Try again in a moment.");
    });
  });
});
