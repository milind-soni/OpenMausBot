import { describe, expect, it } from "vitest";
import { computerStepLine } from "./computer-step";

describe("computer step lines on the Team map", () => {
  it("says what the bot is doing on its computer in a few words", () => {
    expect(computerStepLine({ name: "mcp__computer__open_url", input: JSON.stringify({ url: "https://www.openstreetmap.org/search?q=lisbon" }) })).toBe("Opening openstreetmap.org");
    expect(computerStepLine({ name: "mcp__computer__type_text", input: { text: "Belém Tower\nJerónimos Monastery and the rest of the plan" } })).toBe("Typing “Belém Tower Jerónimos Monast…”");
    expect(computerStepLine({ name: "mcp__computer__key_press", input: { keys: ["ctrl", "l"] } })).toBe("Pressing ctrl+l");
    expect(computerStepLine({ name: "mcp__computer__click", input: "{}" })).toBe("Clicking");
    expect(computerStepLine({ name: "mcp__computer__screenshot" })).toBe("Looking at the screen");
  });

  it("leaves other tools and unreadable input to the usual label", () => {
    expect(computerStepLine({ name: "Bash", input: "{}" })).toBeNull();
    expect(computerStepLine({ name: "mcp__computer__open_url", input: "{not json" })).toBe("Opening a page");
    expect(computerStepLine({ name: "mcp__computer__type_text", input: { text: "  " } })).toBeNull();
  });
});
