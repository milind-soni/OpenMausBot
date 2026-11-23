// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Teammate = { id: string; name: string; base: string; botId: string; createdAt: string };
const fixture = vi.hoisted(() => ({
  teammates: [] as Teammate[],
  calls: [] as Array<{ path: string; method: string; body?: Record<string, string> }>,
  check: { ok: true } as Record<string, unknown>,
  addError: null as string | null,
  listError: null as string | null,
  addGate: null as Promise<void> | null,
}));
vi.mock("@/state/store", () => ({
  api: async (path: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET";
    fixture.calls.push({ path, method, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    if (path === "/api/remote-teammates" && method === "GET") {
      if (fixture.listError) throw new Error(fixture.listError);
      return { teammates: fixture.teammates };
    }
    if (path === "/api/remote-teammates" && method === "POST") {
      await fixture.addGate;
      if (fixture.addError) throw new Error(fixture.addError);
      const body = JSON.parse(init.body!);
      return { teammate: { id: "22222222-2222-4222-8222-222222222222", name: body.name, base: body.address, botId: body.botId, createdAt: "2026-11-23T00:00:00.000Z" } };
    }
    if (path.endsWith("/check")) return fixture.check;
    if (method === "DELETE") return { removed: true };
    throw new Error(`unexpected ${method} ${path}`);
  },
}));
import { RemoteTeammatesSettings } from "./RemoteTeammatesSettings";

const SAVED: Teammate = { id: "11111111-1111-4111-8111-111111111111", name: "Sales desk", base: "https://bots.example.com", botId: "sales-bot", createdAt: "2026-11-22T00:00:00.000Z" };
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(fixture, { teammates: [], calls: [], check: { ok: true }, addError: null, listError: null, addGate: null });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const render = () => act(async () => root.render(createElement(RemoteTeammatesSettings)));
const button = (label: string) => [...document.body.querySelectorAll("button")].find((one) => one.textContent === label);
async function click(label: string) {
  const found = button(label);
  expect(found, label).toBeTruthy();
  await act(async () => found!.click());
}
async function input(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(field, label).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("adds a teammate on another server and lists it without its key", async () => {
  await render();
  expect(container.textContent).toContain("Teammates on other servers");
  expect(container.textContent).toContain("No teammates on other servers yet.");
  await click("Add");
  expect(button("Add teammate")!.disabled).toBe(true);
  await input("Name", "Sales desk");
  await input("Address", "https://bots.example.com");
  await input("Bot id (if the address has none)", "sales-bot");
  await input("Bot API key", "bak_fixture_key_0123456789");
  await click("Add teammate");
  expect(fixture.calls.at(-1)).toEqual({ path: "/api/remote-teammates", method: "POST",
    body: { name: "Sales desk", address: "https://bots.example.com", botId: "sales-bot", key: "bak_fixture_key_0123456789" } });
  expect(container.textContent).toContain("Sales desk was added.");
  expect(container.textContent).toContain("sales-bot · https://bots.example.com");
  expect(container.textContent).not.toContain("No teammates on other servers yet.");
  expect(container.innerHTML).not.toContain("bak_fixture_key");
});

it("shows the server's reason when it refuses a new teammate, and keeps the form", async () => {
  fixture.addError = "that bot is already a teammate";
  await render();
  await click("Add");
  await input("Name", "Sales desk");
  await input("Address", "https://bots.example.com");
  await input("Bot API key", "bak_fixture_key_0123456789");
  await click("Add teammate");
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("that bot is already a teammate");
  expect(container.querySelector('input[aria-label="Name"]')).toBeTruthy();
});

it("tests a saved teammate and says in words whether its key still works", async () => {
  fixture.teammates = [SAVED];
  await render();
  await click("Test");
  expect(fixture.calls.at(-1)).toEqual({ path: `/api/remote-teammates/${SAVED.id}/check`, method: "POST" });
  expect(container.querySelector('[role="status"]')!.textContent).toBe("Connected: the other server takes this key.");
  fixture.check = { ok: false, problem: "wrong_key", status: 401 };
  await click("Test");
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("That server doesn't take this key. Remove this teammate and add it again with a new key.");
  fixture.check = { ok: false, problem: "constructor" };
  await click("Test");
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("That address didn't answer like a Bot API.");
});

it("removes a teammate only after asking, and drops the note that it was added", async () => {
  await render();
  await click("Add");
  await input("Name", "Sales desk");
  await input("Address", "https://bots.example.com");
  await input("Bot API key", "bak_fixture_key_0123456789");
  await click("Add teammate");
  expect(container.textContent).toContain("Sales desk was added.");
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove Sales desk"]')!.click());
  expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(false);
  expect(document.body.textContent).toContain("Remove Sales desk?");
  const confirm = [...document.body.querySelectorAll("button")].filter((one) => one.textContent === "Remove").at(-1)!;
  await act(async () => confirm.click());
  expect(fixture.calls.at(-1)).toEqual({ path: "/api/remote-teammates/22222222-2222-4222-8222-222222222222", method: "DELETE" });
  expect(container.textContent).not.toContain("Sales desk");
  expect(container.textContent).toContain("No teammates on other servers yet.");
});

it("loads the list again on Try again after it could not be read", async () => {
  fixture.listError = "server unreachable";
  await render();
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("server unreachable");
  expect(button("Add")).toBeUndefined();
  fixture.listError = null;
  fixture.teammates = [SAVED];
  await click("Try again");
  expect(fixture.calls.filter((call) => call.method === "GET")).toHaveLength(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("sales-bot · https://bots.example.com");
  expect(button("Add")).toBeTruthy();
});

it("keeps the form open while a teammate is being added, so its answer can't close a newer draft", async () => {
  let release!: () => void;
  fixture.addGate = new Promise((done) => { release = done; });
  await render();
  await click("Add");
  await input("Name", "Sales desk");
  await input("Address", "https://bots.example.com");
  await input("Bot API key", "bak_fixture_key_0123456789");
  await click("Add teammate");
  expect(button("Close")!.disabled).toBe(true);
  await act(async () => { release(); await fixture.addGate; });
  expect(container.textContent).toContain("Sales desk was added.");
  expect(button("Add")!.disabled).toBe(false);
  // After a refused add, Close works again.
  fixture.addError = "that bot is already a teammate";
  await click("Add");
  await input("Name", "Sales desk");
  await input("Address", "https://bots.example.com");
  await input("Bot API key", "bak_fixture_key_0123456789");
  await click("Add teammate");
  expect(button("Close")!.disabled).toBe(false);
  await click("Close");
  expect(container.querySelector('input[aria-label="Name"]')).toBeNull();
});
