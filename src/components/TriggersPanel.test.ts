import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { WebhookTrigger } from "@/lib/webhooks";
import { setLocale, t } from "@/lib/i18n";

// The pop-up's own state, seeded by call order (effects never run under
// server rendering): useWebhookActions owns 0–4, the builder 5–10.
const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  dispatch: vi.fn(),
  webhooks: [] as unknown[],
  bots: [] as unknown[],
  overrides: new Map<number, unknown>(),
  index: 0,
  counting: false,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!fixture.counting) return react.useState(initial);
      const index = fixture.index++;
      const seeded = fixture.overrides.has(index) ? fixture.overrides.get(index) : typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [seeded, () => {}];
    },
  };
});
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({
    state: {
      bots: fixture.bots,
      webhooks: fixture.webhooks,
      webhookAttempts: [],
      routineRuns: [],
      webhookIngress: { available: true },
      instances: [],
      config: null,
    },
    dispatch: fixture.dispatch,
  }),
}));
vi.mock("@/components/Avatar", () => ({ BotAvatar: ({ bot }: { bot: Bot }) => createElement("span", { "data-avatar": bot.id }) }));
import { TRIGGER_SOURCES, TriggersPanel, triggerInput } from "./TriggersPanel";

const CREDENTIALS = 0;
const SOURCE = 5;
const BOT = 7;
const PROMPT = 8;

const bot = (id: string, name: string) => ({ id, name, hidden: false, modelSelection: { instanceId: "claude", model: "m" } }) as unknown as Bot;
const webhook = (id: string, extra: Partial<WebhookTrigger> = {}): WebhookTrigger => ({
  id, endpointId: `ep-${id}`, name: "GitHub", prompt: "", botId: "scout", runOn: "maus", enabled: true,
  createdAt: 1, updatedAt: 1, deliveryCount: 4, lastReceivedAt: Date.now() - 5 * 60_000, ...extra,
});

type Props = { children?: ReactNode; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as ReactElement<Props>;
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree!: ReturnType<typeof TriggersPanel>;
  function Capture() {
    fixture.index = 0;
    fixture.counting = true;
    try { tree = TriggersPanel(); } finally { fixture.counting = false; }
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  fixture.bots = [bot("scout", "Scout"), bot("atlas", "Atlas")];
  fixture.webhooks = [];
  fixture.overrides = new Map();
  vi.stubGlobal("window", { confirm: () => true });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});
afterEach(() => {
  setLocale("en");
  vi.unstubAllGlobals();
});

describe("Triggers pop-up", () => {
  it("reads as a sentence on glass: When [source] → [bot] should", () => {
    const { html } = render();
    expect(html).toContain(">Triggers</h2>");
    expect(html).toContain("Start a task the moment something happens, without asking.");
    expect(html).toContain("glass-surface");
    expect(html).toContain(">When</span>");
    expect(html).toContain(">should</span>");
    for (const label of ["Another app sends a link request", "Typeform", "Zapier", "GitHub", "Stripe"]) expect(html).toContain(`>${label}</option>`);
    expect(html).toContain('<option value="atlas">Atlas</option>');
    expect(html).toContain("Create trigger");
    expect(html).toContain("No triggers yet");
  });

  it("creates through the existing webhook API with the name, bot and instructions", async () => {
    fixture.overrides.set(SOURCE, "github");
    fixture.overrides.set(BOT, "atlas");
    fixture.overrides.set(PROMPT, "  Summarize the failed build.  ");
    const created = webhook("w1", { name: "GitHub", botId: "atlas" });
    fixture.api.mockResolvedValue({ webhook: created, credential: { endpointUrl: "e", secret: "s", url: "https://hooks.example/w1" } });
    const { nodes: tree } = render();
    const form = tree.find((node) => node.props["data-trigger-builder"] !== undefined)!;
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
    await flush();
    expect(fixture.api).toHaveBeenCalledOnce();
    const [url, init] = fixture.api.mock.calls[0]!;
    expect(url).toBe("/api/webhooks");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      name: "GitHub", prompt: "Summarize the failed build.", botId: "atlas", runOn: "maus",
      enabled: true, verificationPending: false, eventTypes: [], maxPendingRuns: null,
    });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "webhookPatched", webhook: created });
  });

  it("names a custom source after what you typed, and falls back to the instructions", () => {
    const bots = fixture.bots as Bot[];
    expect(triggerInput({ source: "custom", customName: " New ticket ", botId: "scout", prompt: "" }, bots).name).toBe("New ticket");
    expect(triggerInput({ source: "custom", customName: "", botId: "scout", prompt: "Reply kindly. Then file it." }, bots).name).toBe("Reply kindly");
    expect(triggerInput({ source: "link", customName: "", botId: "scout", prompt: "" }, bots).name).toBe("Another app sends a link request");
    expect(TRIGGER_SOURCES.map((source) => source.id)).toEqual(["link", "typeform", "zapier", "github", "stripe", "custom"]);
  });

  it("lists triggers as name → bot with deliveries, Copy link and an on/off switch", async () => {
    fixture.webhooks = [webhook("w1"), webhook("w2", { name: "Stripe", enabled: false, botId: "atlas", lastReceivedAt: undefined, deliveryCount: 0 })];
    fixture.overrides.set(CREDENTIALS, { w1: { endpointUrl: "e", secret: "s", url: "https://hooks.example/w1" } });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { html, nodes: tree } = render();
    expect(html).toContain("Your triggers");
    expect(html).toContain('data-trigger-row="w1"');
    expect(html).toMatch(/GitHub<\/span>.*Scout<\/span>/);
    expect(html).toContain("4 received · last 5m ago");
    expect(html).toContain("Nothing received yet");
    expect(html.match(/Copy link/g)).toHaveLength(2);
    expect(html).toMatch(/aria-label="GitHub on or off" type="button" role="switch" aria-checked="true"/);
    expect(html).toMatch(/aria-label="Stripe on or off" type="button" role="switch" aria-checked="false"/);
    expect(html).toContain("Advanced options");
    expect(html).toContain("Rotate private URL");
    expect(html).toContain("Recent deliveries");

    const rows = tree.filter((node) => (node.props.webhook as WebhookTrigger | undefined)?.id);
    const first = rows.find((node) => (node.props.webhook as WebhookTrigger).id === "w1")!;
    (first.props.onCopy as (copy: "link" | "command", replace: boolean) => void)("link", false);
    await flush();
    expect(writeText).toHaveBeenCalledWith("https://hooks.example/w1");
    expect(fixture.api).not.toHaveBeenCalled();

    fixture.api.mockResolvedValue({ webhook: { ...(fixture.webhooks[1] as WebhookTrigger), enabled: true } });
    const second = rows.find((node) => (node.props.webhook as WebhookTrigger).id === "w2")!;
    (second.props.onToggle as () => void)();
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/webhooks/w2", { method: "PATCH", body: JSON.stringify({ enabled: true, verificationPending: false }) });
  });

  it("closes through the store", () => {
    const { nodes: tree } = render();
    const close = tree.find((node) => node.props["aria-label"] === "Close triggers")!;
    (close.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleTriggers", open: false });
  });

  it("disables every row while another trigger action is pending", () => {
    fixture.webhooks = [webhook("w1"), webhook("w2", { name: "Stripe" })];
    fixture.overrides.set(1, "w1:command");
    const { html } = render();
    // Copy link, switch, copy command, rotate, edit and delete on both rows.
    expect(html.match(/ disabled=""/g)).toHaveLength(12);
  });

  it("serializes copy, rotation and other mutations before a pending response returns", async () => {
    fixture.webhooks = [webhook("w1"), webhook("w2", { name: "Stripe" })];
    let resolveRotation!: (value: unknown) => void;
    fixture.api.mockImplementationOnce(() => new Promise((resolve) => { resolveRotation = resolve; }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { nodes: tree } = render();
    const rows = tree.filter((node) => (node.props.webhook as WebhookTrigger | undefined)?.id);
    const copy = (index: number) => (rows[index]!.props.onCopy as (kind: "link", replace: boolean) => void)("link", false);
    copy(0);
    copy(1);
    copy(0);
    (rows[1]!.props.onToggle as () => void)();
    (rows[1]!.props.onDelete as () => void)();
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    resolveRotation({ webhook: fixture.webhooks[0], credential: { endpointUrl: "e1", secret: "s1", url: "https://hooks.example/w1" } });
    await flush();
    expect(writeText).toHaveBeenCalledWith("https://hooks.example/w1");

    fixture.api.mockResolvedValueOnce({ webhook: fixture.webhooks[1], credential: { endpointUrl: "e2", secret: "s2", url: "https://hooks.example/w2" } });
    copy(1);
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith("https://hooks.example/w2");
  });

  it("releases the mutation guard after failure or cancelling a rotation", async () => {
    fixture.webhooks = [webhook("w1")];
    fixture.api.mockRejectedValueOnce(new Error("Offline"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("window", { confirm });
    const row = render().nodes.find((node) => (node.props.webhook as WebhookTrigger | undefined)?.id === "w1")!;
    const copy = row.props.onCopy as (kind: "link", replace: boolean) => void;
    copy("link", false);
    await flush();
    copy("link", true);
    await flush();
    expect(confirm).toHaveBeenCalledOnce();
    expect(fixture.api).toHaveBeenCalledOnce();

    fixture.api.mockResolvedValueOnce({ webhook: fixture.webhooks[0], credential: { endpointUrl: "e", secret: "s", url: "https://hooks.example/w1" } });
    copy("link", false);
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenCalledWith("https://hooks.example/w1");
  });

  it("uses existing translated actions and English fallback keys for the new details", () => {
    fixture.webhooks = [webhook("w1")];
    setLocale("de");
    const { html } = render();
    expect(html).toContain(t("common.delete"));
    expect(html).toContain(t("engineSetup.copyCommand"));
    expect(html).toContain(t("triggers.rotateUrl"));
    expect(html).not.toContain(">Delete</button>");
    expect(html).not.toContain(">Copy command</button>");
  });
});
