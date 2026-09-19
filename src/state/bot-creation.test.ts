import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { botRole, roleProfilePatch } from "@/lib/bot-roles";
import { createBotWithRole, initialState, overlayOpen, reducer, StoreProvider, useStore, type Action, type OverlayKind } from "./store";

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
    dispatch({ type: "closeOverlay", kind: "newBot" });
    dispatch({ type: "openOverlay", kind: "newBot", open: true });
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
    const closed = reducer(pending, { type: "closeOverlay", kind: "newBot" });
    const reopened = reducer(closed, { type: "openOverlay", kind: "newBot", open: true });
    expect(overlayOpen(reopened, "newBot")).toBe(true);
    expect(reopened).toMatchObject({ botCreationPending: true });
    expect(overlayOpen(reducer(reopened, { type: "botCreationPending", on: false }), "newBot")).toBe(true);
    expect(reducer(reopened, { type: "botCreationPending", on: false })).toMatchObject({ botCreationPending: false });
  });

  it("opens one modal with exclusive keyboard ownership", () => {
    const start = {
      ...initialState,
      overlays: { ...initialState.overlays, open: ["settings", "appSettings", "plugins", "shortcuts", "computer"] as OverlayKind[] },
    };
    const next = reducer(start, { type: "openOverlay", kind: "newBot", open: true });
    expect(overlayOpen(next, "newBot")).toBe(true);
    expect(overlayOpen(next, "settings")).toBe(false);
    expect(overlayOpen(next, "appSettings")).toBe(false);
    expect(overlayOpen(next, "plugins")).toBe(false);
    expect(overlayOpen(next, "shortcuts")).toBe(false);
    expect(overlayOpen(next, "computer")).toBe(true);
    const closed = reducer(next, { type: "closeOverlay", kind: "newBot" });
    expect(overlayOpen(closed, "settings")).toBe(false);
    expect(overlayOpen(closed, "plugins")).toBe(false);
  });

  it("opens the requested Plugins surface and remembers it on reopen", () => {
    const next = reducer(
      { ...initialState, overlays: { ...initialState.overlays, open: ["settings"] } },
      { type: "openOverlay", kind: "plugins", open: true, section: "mcp" },
    );
    expect(overlayOpen(next, "plugins")).toBe(true);
    expect(next.overlays.pluginsSurface).toBe("mcp");
    expect(overlayOpen(next, "settings")).toBe(false);
    const closed = reducer(next, { type: "closeOverlay", kind: "plugins" });
    expect(reducer(closed, { type: "openOverlay", kind: "plugins", open: true }).overlays.pluginsSurface).toBe("mcp");
  });
});
