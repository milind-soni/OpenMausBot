// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { NewTaskFolderDialog } from "./NewTaskFolderDialog";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({ useStore: () => ({ dispatch }) }));
const bot = { id: "bot", threadId: "old-thread", name: "Pepper", cwd: "/projects/default",
  projects: [{ id: "project", name: "Project" }],
  tasks: [{ threadId: "old-thread", projectId: "project" }] } as Bot;
let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn<() => void>();
const field = () => document.querySelector<HTMLInputElement>('input')!;
const submit = () => flushSync(() => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const type = (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
  flushSync(() => field().dispatchEvent(new Event("input", { bubbles: true })));
};

beforeEach(() => {
  dispatch.mockReset();
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onClose.mockReset();
  flushSync(() => root.render(createElement(NewTaskFolderDialog, { bot, onClose })));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("new thread working folder", () => {
  it("prefills the default, then submits the explicit path to a new task without editing the old one", () => {
    expect(field().value).toBe("/projects/default");
    expect(document.activeElement).toBe(field());
    type("  /projects/next  ");
    submit();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "newTask", botId: "bot", projectId: "project", cwd: "/projects/next", onCreated: onClose, onError: expect.any(Function) });
    expect(field().disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    submit();
    expect(dispatch).toHaveBeenCalledOnce();
    flushSync(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the path and shows server validation errors so the person can correct and retry", () => {
    type("/missing");
    submit();
    flushSync(() => dispatch.mock.calls[0]![0].onError("that folder doesn't exist: /missing"));
    expect(field().value).toBe("/missing");
    expect(field().disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("that folder doesn't exist");
    expect(document.activeElement).toBe(field());
    expect(onClose).not.toHaveBeenCalled();
    type("/projects/corrected");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(dispatch).toHaveBeenCalledOnce();
    submit();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]![0].cwd).toBe("/projects/corrected");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not create an empty-folder task and lets Escape cancel without a request", () => {
    type("   ");
    submit();
    expect(dispatch).not.toHaveBeenCalled();
    flushSync(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
