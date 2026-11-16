// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: f.state, dispatch: f.dispatch }),
  api: f.api,
}));

import { setLocale } from "@/lib/i18n";
import { GrokConnectorPart } from "./GrokConnector";
import { SettingsLook } from "./SettingsPrimitives";

const LINK = "https://quiet-test-words.trycloudflare.com/mcp/move/abc";
const HANDOFFS = [
  { title: "From Grok Bot: Book the dentist for Friday", state: "needs_you", botId: "chief", threadId: "t2", at: 2 },
  { title: "From Grok Bot: Summarise the launch notes", state: "done", botId: "chief", threadId: "t1", at: 1 },
];

let root: Root;
let host: HTMLElement;
let on: boolean;
let stopped: boolean;
let calls: string[];
const tick = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const shown = () => host.textContent ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
const render = async () => {
  await act(async () => root.render(createElement(SettingsLook.Provider, { value: true }, createElement(GrokConnectorPart))));
  await tick();
};

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("ogb", { remoteClient: { active: false } });
  on = false;
  stopped = false;
  calls = [];
  f.dispatch.mockReset();
  f.state = { config: {}, bots: [{ id: "chief", name: "MausBot", threadId: "t0", tasks: [{ threadId: "t1" }, { threadId: "t2" }] }], groups: [] };
  f.api.mockReset();
  f.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (init?.method === "POST") on = true;
    if (init?.method === "DELETE") on = false;
    return { available: true, ...(on ? { connectorUrl: LINK } : stopped ? { stopped: true } : {}), arrived: [], handoffs: HANDOFFS };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Settings → Import: the Grok Bot connector", () => {
  it("is off until turned on, then shows the link, its Copy and where to paste it, and turns off", async () => {
    await render();
    expect(shown()).toContain("Grok Bot connector");
    expect(shown()).toContain("Lets your Bots in Grok Bot hand tasks to MausBot.");
    expect(host.querySelector('input[aria-label="Link for Grok Bot"]')).toBeNull();
    await act(async () => button("Get the link")!.click());
    await tick();
    expect(shown()).toContain("On. The link changes when MausBot restarts or updates, so add the new one in Grok Bot then.");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Link for Grok Bot"]')!.value).toBe(LINK);
    expect(button("Copy the link")).toBeDefined();
    expect(shown()).toContain("paste this as the Server URL");
    await act(async () => button("Turn off")!.click());
    await tick();
    expect(calls.at(-1)).toBe("DELETE /api/setup-import/grok/connector");
    expect(host.querySelector('input[aria-label="Link for Grok Bot"]')).toBeNull();
    expect(button("Get the link")).toBeDefined();
  });

  it("asks for no arrivals: the move shows those", async () => {
    await render();
    expect(calls[0]).toBe(`GET /api/setup-import/grok/connector?after=${Number.MAX_SAFE_INTEGER}`);
  });

  it("lists the last tasks Grok Bot handed off by title and state, and a click opens that chat", async () => {
    await render();
    const rows = [...host.querySelectorAll<HTMLButtonElement>("[data-grok-handoff]")];
    expect(rows.map((row) => row.textContent)).toEqual(["From Grok Bot: Book the dentist for FridayNeeds you", "From Grok Bot: Summarise the launch notesDone"]);
    expect(shown()).toContain("Tasks from Grok Bot");
    await act(async () => rows[1]!.click());
    expect(f.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "switchTask", botId: "chief", threadId: "t1" }, { type: "revealThread", threadId: "t1" }]);
  });

  it("says when the link stopped and offers a new one", async () => {
    stopped = true;
    await render();
    expect(host.querySelector("[data-grok-move-stopped]")?.textContent).toBe("The link stopped working. Get a new one and paste it into Grok Bot in place of the old one.");
    expect(button("Get the link")).toBeDefined();
  });

  it("waits while the link comes back on as the app starts", async () => {
    f.api.mockImplementation(async () => ({ available: true, opening: true, arrived: [], handoffs: [] }));
    await render();
    expect(button("Get the link")!.disabled).toBe(true);
  });

  it("says so when the link cannot be made", async () => {
    await render();
    f.api.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === "POST") throw new Error("502");
      return { available: true, arrived: [], handoffs: [] };
    });
    await act(async () => button("Get the link")!.click());
    await tick();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't make the link. Check that you're online and try again.");
  });

  it("shows nothing where no link can be made: no cloudflared, a browser or a Cloud", async () => {
    f.api.mockImplementation(async () => ({ available: false, arrived: [], handoffs: [] }));
    await render();
    expect(host.innerHTML).toBe("");
    vi.stubGlobal("ogb", undefined);
    f.api.mockClear();
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(f.api).not.toHaveBeenCalled();
    expect(host.innerHTML).toBe("");
  });
});
