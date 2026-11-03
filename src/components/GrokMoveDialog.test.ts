// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn(), api: vi.fn(), track: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: f.api }));
vi.mock("@/lib/analytics", () => ({ track: f.track }));

import { setLocale } from "@/lib/i18n";
import { GROK_EXPORT_FORMAT, GROK_EXPORT_PROMPT, type GrokItem } from "../../shared/grok-import";
import { GrokItems, GrokMoveDialog } from "./GrokMoveDialog";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const EXPORT = JSON.stringify({ format: GROK_EXPORT_FORMAT, version: 1, bots: [{
  name: "Drew", title: "Lead", instructions: "Run the desk.", memories: ["The door sticks"],
  skills: [{ name: "Greet", instructions: "Say hello." }],
  routines: [{ name: "Open", instruction: "Open.", schedule_cron: "0 9 * * *", timezone: "Asia/Tokyo" }, { name: "Ping", instruction: "Answer the ping.", trigger: "slack", trigger_details: "#door" }],
  apps: [{ name: "Gmail" }],
}] });

let root: Root;
let host: HTMLElement;
const tick = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const shown = () => host.textContent ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
const open = async (onClose = vi.fn()) => {
  await act(async () => root.render(createElement(GrokMoveDialog, { onClose })));
  await tick();
};
const paste = async (reply: string) => {
  const box = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, reply);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Continue")!.click());
  await tick();
};

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("ogb", undefined);
  f.api.mockReset();
  f.track.mockReset();
  f.dispatch.mockReset();
  f.state = { config: {}, bots: [] };
  f.api.mockImplementation(async (path: string) => (path.startsWith("/api/teams/import")
    ? { bots: [{ id: "b1", name: "Drew", threadId: "t1" }], routines: [{ id: "r1", name: "Drew: Open" }], connections: [] }
    : path === "/api/mcp/servers" ? { servers: [] } : {}));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Move from Grok Bot", () => {
  it("goes message, reply, preview with nothing written, import, report", async () => {
    await open();
    expect(shown()).toContain("Copy the message");
    await paste(`Sure, here it is:\n\`\`\`json\n${EXPORT}\n\`\`\`\nAnything else?`);
    expect(host.querySelector('[data-grok-move="preview"]')).not.toBeNull();
    expect(shown()).toContain("Would import");
    expect(shown()).toContain("Drew · Lead");
    expect(shown()).toContain("Skills: 1");
    expect(shown()).toContain("Saved as notes");
    expect(shown()).toContain("Answer the ping.");
    expect(f.api.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/teams/import") || path.includes("/skills/"))).toEqual([]);

    await act(async () => button("Import")!.click());
    await tick();
    expect(host.querySelector('[data-grok-move="report"]')).not.toBeNull();
    expect(shown()).toContain("Imported");
    expect(shown()).toContain("Once you turn each one off in Grok Bot, turn its copy on here: Drew: Open.");
    expect(f.api.mock.calls.map(([path]) => path)).toContain("/api/bots/b1/skills/greet");
    expect(f.track).toHaveBeenCalledOnce();
    expect(button("Move another Bot")).toBeDefined();
  });

  it("ends on the report: no sign-in, no setup steps, no links out", async () => {
    await open();
    await paste(EXPORT);
    await act(async () => button("Import")!.click());
    await tick();
    expect(shown()).toMatch(/Gmail · its login stays in Grok Bot/);
    expect(shown()).not.toMatch(/Sign in|Connect an AI|Review skills/);
    expect(f.dispatch.mock.calls.map(([action]) => action.type)).not.toEqual(expect.arrayContaining(["togglePlugins", "toggleAppSettings", "toggleSettings"]));
  });

  it("refuses an export with keys, says why, and writes nothing", async () => {
    await open();
    await paste(JSON.stringify({ format: GROK_EXPORT_FORMAT, bots: [{ name: "Leaky", api_key: "x" }] }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("bots[0].api_key");
    expect(host.querySelector('[data-grok-move="start"]')).not.toBeNull();
    expect(f.api.mock.calls.map(([path]) => path)).not.toContain("/api/teams/import?mode=add");
  });

  it("reads nothing on this computer from a browser or a Cloud", async () => {
    await open();
    expect(f.api.mock.calls.map(([path]) => path)).not.toContain("/api/setup-import/grok");
  });

  it("on the desktop app looks once it is open, and offers what it found in one tap", async () => {
    vi.stubGlobal("ogb", { remoteClient: { active: false } });
    f.api.mockImplementation(async (path: string) => (path === "/api/setup-import/grok"
      ? { files: [{ name: "grok-bot-export-drew.json", modifiedAt: 1, text: EXPORT }], bots: ["Drew", "Scout"], routines: {} }
      : path === "/api/mcp/servers" ? { servers: [] } : {}));
    await open();
    expect(shown()).toContain("Found in Downloads: Drew");
    expect(shown()).toContain("Your Bots on this computer: Drew, Scout");
    await act(async () => button("Use these")!.click());
    await tick();
    expect(host.querySelector('[data-grok-move="preview"]')).not.toBeNull();
    expect(shown()).toContain("Scout");
  });

  it("scrolls inside the dialog, with its buttons always in view", async () => {
    await open();
    expect(host.querySelector("[data-grok-move-body]")!.className).toContain("overflow-y-auto");
    expect(host.querySelector("[data-grok-move]")!.className).toContain("max-h-");
  });

  it("the message is the export's exact shape, with no product name to translate", () => {
    expect(GROK_EXPORT_PROMPT).toContain(`"format": "${GROK_EXPORT_FORMAT}"`);
    expect(GROK_EXPORT_PROMPT).toContain("grok-bot-export-<your name>.json");
    expect(GROK_EXPORT_PROMPT).toMatch(/Never include passwords, API keys, tokens, webhook keys, cookies or card numbers/);
  });
});

describe("the list", () => {
  it("shows every category with its count, even at none, then conflicts, skips and errors", () => {
    const items: GrokItem[] = [
      { kind: "bot", name: "Quiet", status: "imported" },
      { kind: "app", name: "Linear", status: "conflict", reason: "serverConflict" },
      { kind: "skill", name: "Empty", status: "skipped", reason: "skillEmpty" },
      { kind: "memory", name: "3", status: "error", reason: "memoriesTooBig" },
    ];
    const markup = text(renderToStaticMarkup(createElement(GrokItems, { items, warnings: ["Watch this"], report: true })));
    for (const part of ["Imported", "Bots: 1", "Skills: 0", "Routines: 0", "Memories: 0", "Apps: 0", "Conflicts (skipped)", "Apps: Linear · you already have a server with this name", "Skipped", "Skills: Empty", "Errors", "Worth checking", "Watch this"]) {
      expect(markup, part).toContain(part);
    }
  });
});
