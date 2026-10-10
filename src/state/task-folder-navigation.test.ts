// @vitest-environment happy-dom
// The real provider and dialog share a deliberately delayed HTTP response.
// A rejected folder must not navigate away from the conversation underneath.
import { createElement, useState, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTaskFolderDialog } from "@/components/NewTaskFolderDialog";
import { initialState, StoreProvider, useStore, type Action, type AppState, type Bot } from "./store";

const profile = (id: string): Bot => ({
  id, name: id, threadId: `${id}-old`, title: "", description: "", color: "green", unread: false, notifications: true,
  messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [{ threadId: `${id}-old`, title: "Existing", createdAt: 1 }],
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
class OfflineEvents {
  onopen = null;
  onerror = null;
  onmessage = null;
  close() {}
}

const original = { bots: initialState.bots, selectedId: initialState.selectedId, activeView: initialState.activeView };
const closed = vi.fn();
let host: HTMLDivElement;
let root: Root;
let seen: AppState;
let dispatch: Dispatch<Action>;
let created: ReturnType<typeof deferred>;
let switched: ReturnType<typeof deferred>;
let requests: ReturnType<typeof vi.fn<typeof fetch>>;
function Probe({ dialog }: { dialog: boolean }) {
  const store = useStore();
  seen = store.state;
  dispatch = store.dispatch;
  const [open, setOpen] = useState(dialog);
  return open ? createElement(NewTaskFolderDialog, { bot: seen.bots.find((bot) => bot.id === "B")!,
    onClose: () => { closed(); setOpen(false); } }) : null;
}
const mount = (dialog = true) => flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe, { dialog }))));
const field = () => document.querySelector<HTMLInputElement>('input')!;
const type = (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
  flushSync(() => field().dispatchEvent(new Event("input", { bubbles: true })));
};
const submit = () => {
  type("/projects/chosen");
  flushSync(() => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
};
const newBot = () => ({ ...profile("B"), threadId: "B-new", tasks: [{ threadId: "B-new", title: "New thread", cwd: "/projects/chosen", createdAt: 2 }] });
const createWasSent = () => vi.waitFor(() => expect(requests).toHaveBeenCalledWith("/api/bots/B/tasks", expect.objectContaining({ body: JSON.stringify({ cwd: "/projects/chosen" }) })));

beforeEach(() => {
  Object.assign(initialState, { bots: [profile("A"), profile("B"), profile("C")], selectedId: "A", activeView: "chat" });
  created = deferred();
  switched = deferred();
  requests = vi.fn<typeof fetch>((path) => path === "/api/bots/B/tasks" ? created.promise
    : String(path).startsWith("/api/bots/B/tasks/B-other?") ? switched.promise : new Promise(() => {}));
  vi.stubGlobal("fetch", requests);
  vi.stubGlobal("EventSource", OfflineEvents);
  closed.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  Object.assign(initialState, original);
  vi.unstubAllGlobals();
});

describe("new thread folder navigation", () => {
  it("keeps A selected through B's failed validation, path editing and cancellation", async () => {
    mount();
    submit();
    expect(seen.selectedId).toBe("A");
    await createWasSent();
    created.resolve(response({ error: "that folder doesn't exist: /projects/chosen" }, 400));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("doesn't exist"));
    type("/projects/corrected");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(requests.mock.calls.filter(([path]) => path === "/api/bots/B/tasks")).toHaveLength(1);
    flushSync(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(seen.selectedId).toBe("A");
    expect(seen.bots.find((bot) => bot.id === "B")?.threadId).toBe("B-old");
  });

  it("selects B and its new thread only after a successful response", async () => {
    mount();
    submit();
    expect(seen.selectedId).toBe("A");
    await createWasSent();
    created.resolve(response({ bot: newBot() }, 201));
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(seen.selectedId).toBe("B");
    expect(seen.bots.find((bot) => bot.id === "B")?.threadId).toBe("B-new");
  });

  it("preserves normal one-click creation's immediate selection", () => {
    mount(false);
    flushSync(() => dispatch({ type: "newTask", botId: "B" }));
    expect(seen.selectedId).toBe("B");
  });

  it("does not overwrite a newer same-bot task switch with a late creation response", async () => {
    mount();
    submit();
    await createWasSent();
    flushSync(() => dispatch({ type: "switchTask", botId: "B", threadId: "B-other" }));
    switched.resolve(response({ bot: { ...profile("B"), threadId: "B-other" } }));
    await vi.waitFor(() => expect(seen.bots.find((bot) => bot.id === "B")?.threadId).toBe("B-other"));
    created.resolve(response({ bot: newBot() }, 201));
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(seen.selectedId).toBe("B");
    expect(seen.bots.find((bot) => bot.id === "B")?.threadId).toBe("B-other");
  });

  it.each(["another bot", "away and back", "routines"])("leaves newer navigation to %s in place", async (destination) => {
    mount();
    submit();
    await createWasSent();
    flushSync(() => {
      if (destination === "routines") dispatch({ type: "showRoutines" });
      else {
        dispatch({ type: "select", id: "C" });
        if (destination === "away and back") dispatch({ type: "select", id: "A" });
      }
    });
    created.resolve(response({ bot: newBot() }, 201));
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(seen.selectedId).toBe(destination === "another bot" ? "C" : "A");
    expect(seen.activeView).toBe(destination === "routines" ? "routines" : "chat");
    expect(seen.bots.find((bot) => bot.id === "B")?.threadId).toBe("B-old");
  });
});
