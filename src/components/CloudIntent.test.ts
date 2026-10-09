import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";

const store = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: store.state, dispatch: store.dispatch }), api: vi.fn(async (_path: string, init?: RequestInit) => ({ onboarding: JSON.parse(String(init?.body)).onboarding })) }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/components/onboarding/view-transition", () => ({ withViewTransition: (update: () => void) => { update(); return null; } }));
vi.mock("@/lib/cloud-intent", async original => {
  const actual = await original<typeof import("@/lib/cloud-intent")>();
  return { ...actual, dismissCloudIntent: vi.fn(actual.dismissCloudIntent) };
});
import { CloudIntent } from "./CloudIntent";
import { dismissCloudIntent } from "@/lib/cloud-intent";
import { api } from "@/state/store";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
const text = (node: Node): string => Children.toArray(node.props.children).map(child => typeof child === "string" ? child : isValidElement(child) ? text(child as Node) : "").join("");
function render() {
  let tree: ReactNode;
  function Capture() { tree = CloudIntent(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.state = { instances: [], bots: [{ id: "b1", threadId: "t1" }], selectedId: "b1", config: { onboarding: { ...EMPTY_ONBOARDING } } };
  setLocale("en");
});

it("asks with /setup in front, offers ideas, and says plainly how to skip", () => {
  const { html } = render();
  expect(html).toContain("What should My Cloud do while you&#x27;re away?");
  expect(html).toContain("/setup");
  for (const idea of ["News digest", "Watch a page", "Research roundup", "Plan my day"]) expect(html).toContain(idea);
  expect(html).toContain("Skip for now");
  expect(html).toContain("Esc");
  expect(html).toContain("You can come back to it any time");
  // Not a dialog: the sidebar and everything else stay reachable.
  expect(html).not.toContain('aria-modal="true"');
});

it("Skip for now steps aside at once and is kept in the Cloud's record, so no device asks again", async () => {
  const skip = render().nodes.find(node => node.type === "button" && text(node) === "Skip for now")!;
  skip.props.onClick!();
  expect(dismissCloudIntent).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: ["cloud-intent-asked"] } }) });
});

it("sends nothing while the box is empty", () => {
  const send = render().nodes.find(node => node.type === "button" && (node.props as { "aria-label"?: string })["aria-label"] === "Start setting it up")!;
  expect((send.props as { disabled?: boolean }).disabled).toBe(true);
  send.props.onClick!();
  expect(store.dispatch).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
});
