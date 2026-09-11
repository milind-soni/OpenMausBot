import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { botRole, roleProfilePatch } from "@/lib/bot-roles";
import { createBotWithRole, initialState, reducer, StoreProvider, useStore, type Action } from "./store";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// Capture the real command handler without mounting live event effects.
function mount(request: typeof fetch) {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  return dispatch;
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bot presets", () => {
  const bot = { id: "created", name: "Scout", messages: [] };

  it("creates a blank bot with just one request", async () => {
    const request = vi.fn().mockResolvedValue({ bot });
    expect(await createBotWithRole(undefined, request)).toEqual({ bot });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/bots", { method: "POST" });
  });

  it("applies a preset only to the bot returned by creation", async () => {
    const role = botRole("research")!;
    const request = vi.fn().mockResolvedValueOnce({ bot }).mockResolvedValueOnce({ bot: { ...roleProfilePatch(role) } });
    const created = await createBotWithRole(role, request);
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({ name: role.name, title: role.title, description: role.description });
    expect(request).toHaveBeenLastCalledWith("/api/bots/created", { method: "PATCH", body: JSON.stringify(roleProfilePatch(role)) });
    expect(created.bot).toMatchObject({ id: "created", soul: role.soul, messages: [] });
  });

  it("retains the already-created bot if its optional preset fails, without creating another", async () => {
    const request = vi.fn().mockResolvedValueOnce({ bot }).mockRejectedValueOnce(new Error("profile unavailable"));
    expect(await createBotWithRole(botRole("research"), request)).toEqual({ bot, profileError: "profile unavailable" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not apply a profile after failed creation", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(createBotWithRole(botRole("research"), request)).rejects.toThrow("offline");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("shared bot creation guard", () => {
  const bot = { id: "created", name: "Scout", messages: [] };

  it.each([false, true])("blocks duplicates across dismissal through preset completion (profile failure: %s)", async (profileFails) => {
    const post = deferred();
    const profile = deferred();
    const request = vi.fn<typeof fetch>().mockReturnValueOnce(post.promise).mockReturnValueOnce(profile.promise).mockResolvedValue(response({ bot }));
    const dispatch = mount(request);
    const onCreated = vi.fn();
    const onError = vi.fn();
    dispatch({ type: "newBot", role: botRole("research"), onCreated, onError });
    dispatch({ type: "toggleNewBot", open: false });
    dispatch({ type: "toggleNewBot", open: true });
    dispatch({ type: "newBot" });
    expect(request).toHaveBeenCalledTimes(1);
    post.resolve(response({ bot }));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    dispatch({ type: "newBot" });
    expect(request).toHaveBeenCalledTimes(2);
    profile.resolve(response(profileFails ? { error: "profile unavailable" } : { bot }, profileFails ? 500 : 200));
    await flush();
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    dispatch({ type: "newBot" });
    await flush();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("releases the guard after POST failure so a fresh attempt can succeed", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(response({ bot }));
    const dispatch = mount(request);
    const onError = vi.fn();
    const onCreated = vi.fn();
    dispatch({ type: "newBot", onError, onCreated });
    dispatch({ type: "newBot" });
    await flush();
    expect(request).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("offline");
    expect(onCreated).not.toHaveBeenCalled();
    dispatch({ type: "newBot", onCreated });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledOnce();
  });
});

describe("setup navigation", () => {
  it("keeps creation pending through close/reopen until the request settles", () => {
    const pending = reducer(initialState, { type: "botCreationPending", on: true });
    const closed = reducer(pending, { type: "toggleNewBot", open: false });
    const reopened = reducer(closed, { type: "toggleNewBot", open: true });
    expect(reopened).toMatchObject({ newBotOpen: true, botCreationPending: true });
    expect(reducer(reopened, { type: "botCreationPending", on: false })).toMatchObject({ newBotOpen: true, botCreationPending: false });
  });

  it("opens one modal with exclusive keyboard ownership", () => {
    const start = { ...initialState, settingsOpen: true, appSettingsOpen: true, pluginsOpen: true, shortcutsOpen: true, computerOpen: true };
    const next = reducer(start, { type: "toggleNewBot", open: true });
    expect(next).toMatchObject({ newBotOpen: true, settingsOpen: false, appSettingsOpen: false, pluginsOpen: false, shortcutsOpen: false, computerOpen: true });
    expect(reducer(next, { type: "toggleNewBot", open: false })).toMatchObject({ settingsOpen: false, pluginsOpen: false });
  });

  it("opens the requested Plugins surface and remembers it on reopen", () => {
    const next = reducer({ ...initialState, settingsOpen: true }, { type: "togglePlugins", open: true, surface: "mcp" });
    expect(next).toMatchObject({ pluginsOpen: true, pluginsSurface: "mcp", settingsOpen: false });
    const closed = reducer(next, { type: "togglePlugins", open: false });
    expect(reducer(closed, { type: "togglePlugins", open: true })).toMatchObject({ pluginsSurface: "mcp" });
  });
});
