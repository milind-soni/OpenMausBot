import { describe, expect, it, vi } from "vitest";
import { botRole, roleProfilePatch } from "@/lib/bot-roles";
import { createBotWithRole, initialState, reducer } from "./store";

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

describe("setup navigation", () => {
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
