import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ dispatch: vi.fn(), dismiss: vi.fn(), cloudHome: false, live: undefined as Record<string, unknown> | undefined }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useId: () => "live-key-title" }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { cloudHome: f.cloudHome, live: f.live } }, dispatch: f.dispatch }), api: vi.fn() }));
vi.mock("@/lib/live-call-media", () => ({ dismissLiveNotice: f.dismiss }));
import { LiveKeyNeeded } from "./LiveKeyNeeded";
import { LiveCallSettings } from "./LiveCallSettings";
import { finishKeyFocus, useKeyFocus } from "./keys/key-focus";

beforeEach(() => {
  vi.clearAllMocks();
  f.cloudHome = false;
  f.live = undefined;
});

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
const nodes = (value: ReactNode): Node[] => !isValidElement(value) ? [] : [value as Node, ...Children.toArray((value as Node).props.children).flatMap(nodes)];

it("Qwen key prompts and Call settings use the same masked editor, Qwen voice and usage disclosure", () => {
  f.live = { configured: false, provider: "qwen", qwenKeyConfigured: false, voice: "marin", readTypedReplies: true, idleMinutes: 5 };
  for (const view of [createElement(LiveKeyNeeded), createElement(LiveCallSettings, { onClose: () => {} })]) {
    const html = renderToStaticMarkup(view);
    expect(html).toContain('aria-label="Qwen API key for Live calls"');
    expect(html).toContain('data-key-input');
    expect(html).toContain('value="longanqian_v3.1"');
    expect(html).toContain("Billed by usage");
    expect(html).toContain("headphones");
    expect(html).not.toContain("$0.05");
    expect(html).not.toContain('value="marin"');
    expect(html).not.toContain("OpenAI key stays");
  }
});

it("says one plain thing, names OpenAI, and offers only the way to Settings → API keys", () => {
  const html = renderToStaticMarkup(createElement(LiveKeyNeeded));
  expect(html).toContain('<h2 id="live-key-title"');
  expect(html).toContain("Live calls use your own OpenAI key. Add it in Settings → API keys.");
  expect(html).toContain(">Open API keys</button>");
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain("The OpenAI key stays on your computer.");
  for (const gone of ["Pro", "plan", "<input", "$15"]) expect(html).not.toContain(gone);
  f.cloudHome = true;
  expect(renderToStaticMarkup(createElement(LiveKeyNeeded))).toContain("The OpenAI key stays in the Cloud.");
});

it("opens Settings at the OpenAI key in Voice and calls, and puts the prompt away", () => {
  const button = nodes(LiveKeyNeeded()).find((node) => node.type === "button");
  expect(button).toBeTruthy();
  button!.props.onClick!();
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleAppSettings", open: true, section: "connections" });
  let request: ReturnType<typeof useKeyFocus> = null;
  renderToStaticMarkup(createElement(() => { request = useKeyFocus(); return null; }));
  expect(request).toMatchObject({ id: "openai", row: "liveCalls" });
  finishKeyFocus(request!);
  expect(f.dismiss).toHaveBeenCalledOnce();
});

it("with Azure chosen, asks for the endpoint, deployment and resource key in place, and names Azure rather than OpenAI", () => {
  f.live = { configured: false, provider: "azure", azureEndpoint: "https://my-res.openai.azure.com", voice: "", readTypedReplies: true, idleMinutes: 5 };
  const html = renderToStaticMarkup(createElement(LiveKeyNeeded));
  expect(html).toContain("Live calls through Azure OpenAI need the resource endpoint");
  expect(html).toContain('value="https://my-res.openai.azure.com"');
  expect(html).toContain('placeholder="gpt-live-1"');
  expect(html).toContain('aria-label="Azure OpenAI key for Live calls"');
  expect(html).toContain("The Azure key stays on your computer.");
  expect(html).not.toContain("Open API keys");
  expect(html).not.toContain("OpenAI key stays");
});

it("with Azure chosen and no endpoint yet, asks for the endpoint first: a key is tied to it", () => {
  f.live = { configured: false, provider: "azure", voice: "", readTypedReplies: true, idleMinutes: 5 };
  const html = renderToStaticMarkup(createElement(LiveKeyNeeded));
  expect(html).toContain('placeholder="https://my-resource.openai.azure.com"');
  expect(html).not.toContain('aria-label="Azure OpenAI key for Live calls"');
});
