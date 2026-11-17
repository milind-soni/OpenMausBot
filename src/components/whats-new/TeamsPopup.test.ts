// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { TeamsAction } from "@/lib/teams-whats-new";

const avatars = vi.hoisted(() => [] as Array<{ animated?: boolean }>);
vi.mock("@/components/Avatar", () => ({ MausAvatar: (props: { animated?: boolean }) => { avatars.push(props); return null; } }));
const { TeamsPopup, TEAMS_POPUP } = await import("./TeamsPopup");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
const onStep = vi.fn(), onStart = vi.fn(), onDone = vi.fn();
async function show(action: TeamsAction) {
  root = createRoot(host);
  await act(async () => { root!.render(createElement(TeamsPopup, { action, onStep, onStart, onDone })); });
  return document.querySelector<HTMLElement>(TEAMS_POPUP)!;
}
const key = async (name: string, shiftKey = false) => {
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })); });
};
const buttons = (popup: HTMLElement) => [...popup.querySelectorAll("button")].map(button => button.textContent || button.getAttribute("aria-label"));

beforeEach(() => {
  setLocale("en"); avatars.length = 0; vi.clearAllMocks();
  delete document.documentElement.dataset.reducedMotion;
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); });

describe("the Teams popup", () => {
  it("each audience has its own buttons: invite for a team's admins, Got it for its members, Start a team and Not now for everyone else", async () => {
    let popup = await show({ kind: "start", inApp: true, url: "https://cloud.example/pro/buy" });
    expect(popup.getAttribute("role")).toBe("dialog");
    expect(popup.textContent).toContain("MausBot is better with your team");
    expect(popup.textContent).toContain("$40 a month for 2 people, $20 for each extra person.");
    expect(buttons(popup)).toEqual(["Start a team", "Not now", "Close"]);
    expect(document.activeElement?.textContent, "focus starts at its main button").toBe("Start a team");
    await act(async () => { (popup.querySelector("[data-primary] button") as HTMLElement).click(); });
    expect(onStart).toHaveBeenCalled();
    expect(onStep.mock.calls.map(([step]) => step)).toEqual(["seen", "start_team"]);
    expect(onDone).toHaveBeenCalledTimes(1);
    await act(async () => root?.unmount()); root = null;

    popup = await show({ kind: "got-it" });
    expect(buttons(popup)).toEqual(["Got it", "Close"]);
    await act(async () => root?.unmount()); root = null;
    popup = await show({ kind: "invite", url: "https://admin.example/cloud/team/t/people?do=invite" });
    expect(buttons(popup)).toEqual(["Invite your team", "Not now", "Close"]);
  });

  it("Escape closes it, and Tab keeps focus inside", async () => {
    const popup = await show({ kind: "start", inApp: false, url: "https://cloud.example/pro/buy" });
    const list = [...popup.querySelectorAll<HTMLElement>("button")];
    list.at(-1)!.focus();
    await key("Tab");
    expect(document.activeElement).toBe(list[0]);
    await key("Tab", true);
    expect(document.activeElement).toBe(list.at(-1));
    await key("Escape");
    expect(onStep).toHaveBeenLastCalledWith("close");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("the card grows in and four teammates join the bot one after another, all within about 600 ms", async () => {
    const popup = await show({ kind: "got-it" });
    expect(popup.className).toContain("teams-card-in");
    const faces = [...popup.querySelectorAll<HTMLElement>("[data-teams-face]")];
    expect(faces.map(face => face.dataset.teamsFace)).toEqual(["Ada", "Ben", "Cleo", "Dara"]);
    expect(faces.map(face => face.style.getPropertyValue("--face"))).toEqual(["0", "1", "2", "3"]);
    for (const face of faces) expect(face.className).toContain("teams-face-in");
    expect(avatars.at(-1)?.animated).toBe(true);
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8").replace(/\r\n/g, "\n");
    const ms = (pattern: RegExp) => Number(pattern.exec(css)![1]);
    const card = ms(/\.teams-card-in \{ animation: teams-card-in (\d+)ms/), face = ms(/\.teams-face-in \{ animation: teams-face-in (\d+)ms/);
    const [, start, step] = /animation-delay: calc\((\d+)ms \+ var\(--face, 0\) \* (\d+)ms\)/.exec(css)!.map(Number);
    expect(Math.max(card, start! + 3 * step! + face)).toBeLessThanOrEqual(650);
    expect(css, "each rests visible").toMatch(/@keyframes teams-face-in \{\n  from \{ opacity: 0;[^}]*\}\n  to \{ opacity: 1;/);
  });

  it("with reduced motion nothing moves: no entrance, no faces flying in, a still bot", async () => {
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8").replace(/\r\n/g, "\n");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n  \.teams-card-in, \.teams-face-in \{ animation: none; \}/);
    expect(css).toMatch(/:root\[data-reduced-motion="true"\] \.teams-card-in,\n:root\[data-reduced-motion="true"\] \.teams-face-in \{\n  animation: none !important;/);
    document.documentElement.dataset.reducedMotion = "true";
    await show({ kind: "got-it" });
    expect(avatars.at(-1)?.animated).toBe(false);
  });
});
