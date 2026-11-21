// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { CompactionChip } from "./DigestChip";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const summary: Message = {
  id: "context", role: "bot", kind: "compaction", at: 1,
  compaction: { summary: "The user wants X.", firstKeptId: "", foldedThroughId: "old", tokensBefore: 1, by: "harness" },
};
const engine: Message = { id: "engine", role: "bot", kind: "compaction", at: 1, engineCompaction: true };
const fresh: Message = { ...summary, compaction: { ...summary.compaction!, summary: "", fresh: true } };

function render(message: Message, onNewChat?: () => void) {
  flushSync(() => root.render(createElement(CompactionChip, { message, onNewChat })));
  return host.querySelector<HTMLElement>("[data-testid=new-chat-hint]");
}

it("offers a new chat under a summarized or engine-compacted chat, and the button starts one", () => {
  for (const message of [summary, engine]) {
    const onNewChat = vi.fn();
    const hint = render(message, onNewChat);
    expect(hint?.textContent).toContain("Start a new chat to save tokens.");
    const button = hint?.querySelector("button");
    expect(button?.textContent).toBe("New chat");
    flushSync(() => button?.click());
    expect(onNewChat).toHaveBeenCalledTimes(1);
  }
});

it("shows no hint on a Start fresh divider or when the chat can't start a new one", () => {
  expect(render(fresh, vi.fn())).toBeNull();
  expect(host.querySelector("[data-testid=fresh-start-divider]")).not.toBeNull();
  expect(render(summary)).toBeNull();
  expect(host.querySelector("[data-testid=compaction-chip]")).not.toBeNull();
  expect(render(engine)).toBeNull();
  expect(host.querySelector("[data-testid=engine-compaction-chip]")).not.toBeNull();
});
