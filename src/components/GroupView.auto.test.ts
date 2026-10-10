import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, ConfigStatus, Group, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ config: null as ConfigStatus | null, dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

import { DefaultResponderSelect, RoutedByLine, Transcript } from "./GroupView";

const members = [
  { id: "maya", name: "Maya" },
  { id: "theo", name: "Theo" },
] as Bot[];
const room = (defaultResponder: Group["defaultResponder"]) => ({ id: "room", defaultResponder } as Group);
const jev = (enabled: boolean): ConfigStatus => ({ decider: { provider: "jev", configured: enabled, enabled, jobs: { roomRouting: true } } } as ConfigStatus);

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}

beforeEach(() => {
  fixture.config = jev(true);
  fixture.dispatch.mockReset();
});

describe("room responder selector", () => {
  it("offers Auto (Jev) and shows it selected on an Auto room", () => {
    const markup = renderToStaticMarkup(createElement(DefaultResponderSelect, { group: room({ kind: "auto" }), members }));
    expect(markup).toContain('<option value="auto" selected="">Auto (Jev)</option>');
    expect(markup).toContain("Jev picks who answers each plain message");
  });

  it("reads plain Auto, and names who answers, while Jev is off", () => {
    fixture.config = jev(false);
    const markup = renderToStaticMarkup(createElement(DefaultResponderSelect, { group: room({ kind: "auto", fallbackBotId: "theo" }), members }));
    expect(markup).toContain('<option value="auto" selected="">Auto</option>');
    expect(markup).toContain("Jev is off, so plain messages go to Theo");
  });

  it("switching a lead room to Auto keeps the lead as its fallback", () => {
    const tree = DefaultResponderSelect({ group: room({ kind: "member", botId: "theo" }), members });
    const select = nodes(tree).find((node) => node.type === "select")!;
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "auto" } });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "patchGroup", groupId: "room", patch: { defaultResponder: { kind: "auto", fallbackBotId: "theo" } } });
  });
});

describe("routed-by line", () => {
  it("says Jev picked the speaker, with how sure it was", () => {
    expect(renderToStaticMarkup(createElement(RoutedByLine, { routedBy: { provider: "jev", probability: 0.94 } }))).toContain("Picked by Jev · 94%");
  });

  it("appears under a Jev-routed reply only", () => {
    const reply = (id: string, extra: Partial<Message> = {}): Message =>
      ({ id, role: "bot", kind: "text", text: `reply ${id}`, at: 1_000, from: { botId: "theo", name: "Theo", color: "green" }, ...extra });
    const messages = [reply("routed", { routedBy: { provider: "jev", probability: 0.94 } }), reply("plain", { at: 2_000 })];
    vi.stubGlobal("window", {});
    const markup = renderToStaticMarkup(createElement(Transcript, {
      group: { ...room({ kind: "auto" }), threadId: "thread", messages } as Group, members, locale: "en",
      messages, transcript: messages, onReply: () => undefined,
    }));
    expect(markup.match(/Picked by Jev/g)).toHaveLength(1);
    expect(markup.indexOf("Picked by Jev")).toBeGreaterThan(markup.indexOf("reply routed"));
    expect(markup.indexOf("Picked by Jev")).toBeLessThan(markup.indexOf("reply plain"));
    vi.unstubAllGlobals();
  });
});
