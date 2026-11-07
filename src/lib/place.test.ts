import { describe, expect, it } from "vitest";
import { effectivePlace, isComputerPlace, PLACES, placeLabelKey, placeOffered, screenToolLive, toolPlace } from "./place";
import { toolSurfaceKind } from "../../shared/tool-surface";

describe("where a conversation works", () => {
  it("lets the conversation's pin win over the bot's Works on, except Off", () => {
    expect(effectivePlace({ computer: "cloud" }, { surface: "browser" })).toBe("browser");
    expect(effectivePlace({ computer: undefined }, { surface: "vm" })).toBe("vm");
    expect(effectivePlace({ computer: "browser" }, { surface: "local" })).toBe("local");
    expect(effectivePlace({ computer: "off" }, { surface: "browser" })).toBe("off");
    expect(effectivePlace({ computer: "cloud" }, null)).toBe("cloud");
    expect(effectivePlace({ computer: undefined }, undefined)).toBe("auto");
  });

  it("offers every place on a desktop or self-hosted server, and no this computer or Local VM on an OMB Cloud home", () => {
    for (const config of [null, undefined, {}, { cloudHome: false }]) {
      expect(PLACES.filter((place) => placeOffered(place, config))).toEqual(["cloud", "vm", "local", "browser"]);
    }
    expect(PLACES.filter((place) => placeOffered(place, { cloudHome: true }))).toEqual(["cloud", "browser"]);
  });

  it("names places with one label key each", () => {
    expect(placeLabelKey("cloud")).toBe("place.cloud");
    expect(placeLabelKey("auto")).toBe("place.auto");
    expect(isComputerPlace("vm")).toBe(true);
    expect(isComputerPlace("browser")).toBe(false);
    expect(isComputerPlace("auto")).toBe(false);
  });

  it("gives browser tools the browser, computer tools the conversation's computer, and other tools nothing", () => {
    expect(toolPlace("agent_browser_snapshot", "cloud")).toBe("browser");
    expect(toolPlace("mcp__browser__browser_click", "vm")).toBe("browser");
    expect(toolPlace("mcp__computer__screenshot", "cloud")).toBe("cloud");
    expect(toolPlace("click", "local")).toBe("local");
    expect(toolPlace("computer_exec", "vm")).toBe("vm");
    expect(toolPlace("browser_click", "cloud")).toBe("cloud");
    expect(toolPlace("screenshot", "auto")).toBeNull();
    expect(toolPlace("screenshot", "browser")).toBeNull();
    for (const name of ["Bash", "Read", "list_bots", "recall", "propose_routine", "mcp__agents__ask_bot"]) {
      expect(toolPlace(name, "cloud"), name).toBeNull();
    }
  });

  it("knows when a running tool call is using the bot's screen", () => {
    const messages = [
      { id: "old-click", tool: { name: "mcp__computer__click" } },
      { id: "text" },
      { id: "bash", tool: { name: "Bash" } },
      { id: "snap", tool: { name: "mcp__browser__browser_snapshot" } },
      { id: "shot", tool: { name: "screenshot" } },
    ];
    expect(screenToolLive(messages, new Set(), "cloud")).toBe(false);
    expect(screenToolLive(messages, new Set(["bash"]), "cloud")).toBe(false);
    expect(screenToolLive(messages, new Set(["bash", "snap"]), "auto")).toBe(true);
    expect(screenToolLive(messages, new Set(["shot"]), "cloud")).toBe(true);
    expect(screenToolLive(messages, new Set(["shot"]), "auto")).toBe(false);
    expect(screenToolLive(messages, new Set(["text"]), "cloud")).toBe(false);
  });

  it("classifies tool names without guessing computer for unrelated tools", () => {
    expect(toolSurfaceKind("agent_browser_open")).toBe("browser");
    expect(toolSurfaceKind("browser__snapshot")).toBe("browser");
    expect(toolSurfaceKind("computer__click")).toBe("computer");
    expect(toolSurfaceKind("hotkey")).toBe("computer");
    expect(toolSurfaceKind("Bash")).toBeNull();
    expect(toolSurfaceKind("mcp__agents__list_bots")).toBeNull();
  });
});
