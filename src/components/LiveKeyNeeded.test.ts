import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ dispatch: vi.fn(), dismiss: vi.fn(), cloudHome: false }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useId: () => "live-key-title" }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { cloudHome: f.cloudHome } }, dispatch: f.dispatch }) }));
vi.mock("@/lib/live-call-media", () => ({ dismissLiveNotice: f.dismiss }));
import { LiveKeyNeeded } from "./LiveKeyNeeded";
import { finishKeyFocus, useKeyFocus } from "./keys/key-focus";

beforeEach(() => {
  vi.clearAllMocks();
  f.cloudHome = false;
});

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
const nodes = (value: ReactNode): Node[] => !isValidElement(value) ? [] : [value as Node, ...Children.toArray((value as Node).props.children).flatMap(nodes)];

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
