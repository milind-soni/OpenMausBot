// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VoicePicker, voiceListPlace, type PickerVoice } from "./VoicePicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NARRATOR: PickerVoice = {
  id: "a".repeat(32),
  label: "British Narrator",
  description: "A calm, measured male voice with a strong, clear delivery for long reads, audiobooks and explainers.",
};
const STUDIO: PickerVoice = { id: "b".repeat(32), label: "Studio Voice" };
const LIBRARY: PickerVoice = { id: "lib-1", label: "Library Rachel", description: "irish", publicOwnerId: "owner2" };

type Props = Parameters<typeof VoicePicker>[0];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  // Menus unmount at once with reduced motion, so a closed list is simply gone.
  document.documentElement.dataset.reducedMotion = "true";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.reducedMotion;
});

function Harness(props: Partial<Props>) {
  const [query, setQuery] = useState("");
  return createElement(VoicePicker, {
    value: "",
    voices: [NARRATOR, STUDIO],
    loading: false,
    query,
    onQuery: setQuery,
    onPick: () => {},
    defaultLabel: "Pick a voice",
    ariaLabel: "Pepper's voice",
    ...props,
  });
}

const mount = (props: Partial<Props> = {}) => act(async () => root.render(createElement(Harness, props)));
const trigger = () => host.querySelector<HTMLButtonElement>("[data-voice-picker]")!;
const sheet = () => document.body.querySelector<HTMLElement>("[data-voice-picker-list]");
const search = () => sheet()!.querySelector<HTMLInputElement>("input")!;
const options = () => [...sheet()!.querySelectorAll<HTMLElement>('[role="option"]')];
const open = () => act(async () => trigger().click());
const press = async (key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => search().dispatchEvent(event));
  return event;
};
const type = (text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), text);
    search().dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("VoicePicker", () => {
  it("floats the list over the page, not inside the settings panel, and puts the cursor in the search box", async () => {
    await mount({ value: NARRATOR.id });
    expect(sheet()).toBeNull();
    await open();

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(sheet()!.parentElement).toBe(document.body);
    expect(host.contains(sheet())).toBe(false);
    expect(sheet()!.style.position).toBe("fixed");
    expect(sheet()!.style.visibility).toBe("");
    expect(document.activeElement).toBe(search());
    expect(search().placeholder).toBe("Search voices or paste a link");
  });

  it("shows each voice's name on one line and its description on one clamped line, with a check on the current voice", async () => {
    await mount({ value: NARRATOR.id });
    await open();

    expect(options().map((row) => row.querySelector("span > span")!.textContent)).toEqual(["Pick a voice", "British Narrator", "Studio Voice"]);
    const description = [...options()[1]!.querySelectorAll("span")].find((span) => span.textContent === NARRATOR.description)!;
    expect(description.className).toContain("truncate");
    expect(description.getAttribute("title")).toBe(NARRATOR.description);
    expect(options().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(options().map((row) => Boolean(row.querySelector("svg")))).toEqual([false, true, false]);
  });

  it("walks the rows with the arrow keys and picks the highlighted one with Enter", async () => {
    const onPick = vi.fn();
    await mount({ onPick });
    await open();
    const active = () => options().findIndex((row) => row.dataset.active !== undefined);

    expect(active()).toBe(0);
    await press("ArrowDown");
    await press("ArrowDown");
    expect(active()).toBe(2);
    expect(search().getAttribute("aria-activedescendant")).toBe(options()[2]!.id);
    await press("ArrowDown");
    expect(active()).toBe(2);
    await press("ArrowUp");
    expect(active()).toBe(1);

    await press("Enter");
    expect(onPick).toHaveBeenCalledWith(NARRATOR);
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("clears the search on the first Escape and closes on the second, without letting it reach the panel", async () => {
    await mount();
    await open();
    await type("stu");
    expect(search().value).toBe("stu");

    const first = await press("Escape");
    expect(first.defaultPrevented).toBe(true);
    expect(search().value).toBe("");
    expect(sheet()).not.toBeNull();

    const second = await press("Escape");
    expect(second.defaultPrevented).toBe(true);
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on a click outside, and stays open for a click inside the list", async () => {
    await mount();
    await open();
    await act(async () => options()[1]!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(sheet()).not.toBeNull();
    await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(sheet()).toBeNull();
  });

  it("will not pick from a list that has not caught up with the search yet", async () => {
    const onPick = vi.fn();
    await mount({ onPick, loading: true, query: "stud" });
    await open();

    expect(options()).toHaveLength(2);
    expect(sheet()!.querySelector('[role="listbox"]')!.getAttribute("aria-busy")).toBe("true");
    await press("Enter");
    await act(async () => options()[1]!.click());
    expect(onPick).not.toHaveBeenCalled();
  });

  it("shows skeleton rows while the first list loads, and a short note when nothing matches", async () => {
    await mount({ value: "c".repeat(32), voices: [], loading: true });
    expect(trigger().textContent).toBe("Loading voices…");
    await open();
    expect(sheet()!.querySelectorAll("[data-voice-skeleton]")).toHaveLength(4);
    expect(options()).toHaveLength(0);

    await mount({ voices: [], query: "zzzz" });
    expect(options()).toHaveLength(0);
    expect(sheet()!.textContent).toContain("No voices match");
    expect(sheet()!.textContent).toContain("Try another name, or paste a link to the voice.");
  });

  it("puts your own voices above the ElevenLabs library and says once what picking a library voice does", async () => {
    await mount({ voices: [LIBRARY, STUDIO], query: "ra" });
    await open();

    expect(options().map((row) => row.querySelector("span > span")!.textContent)).toEqual(["Studio Voice", "Library Rachel"]);
    const text = sheet()!.querySelector('[role="listbox"]')!.textContent!;
    expect(text.indexOf("Your voices")).toBeLessThan(text.indexOf("Studio Voice"));
    expect(text.indexOf("ElevenLabs Voice Library")).toBeLessThan(text.indexOf("Library Rachel"));
    expect(text.match(/Picking one adds it to your voices\./g)).toHaveLength(1);

    await mount({ voices: [STUDIO], query: "stu" });
    expect(sheet()!.textContent).not.toContain("Your voices");
  });

  it("names a selected voice the list has not loaded yet", async () => {
    await mount({ value: "c".repeat(32), voices: [] });
    expect(trigger().textContent).toBe("Current agent voice");
  });

  it("shows the library voice being added in the field and holds the field until it is", async () => {
    await mount({ value: STUDIO.id, pending: LIBRARY });
    expect(trigger().textContent).toBe("Library RachelAdding…");
    expect(trigger().disabled).toBe(true);
    expect(trigger().querySelector(".animate-spin")).not.toBeNull();
  });
});

describe("voiceListPlace", () => {
  const viewport = { width: 1000, height: 800 };
  const field = (top: number, left = 100, width = 300) => ({ left, right: left + width, top, bottom: top + 38, width });

  it("opens below the field when the list fits there", () => {
    expect(voiceListPlace(field(100), viewport)).toEqual({ left: 100, width: 300, maxHeight: 380, top: 142 });
  });

  it("still opens below when a good part of the list fits, and flips above when it does not", () => {
    expect(voiceListPlace(field(480), viewport)).toEqual({ left: 100, width: 300, maxHeight: 270, top: 522 });
    expect(voiceListPlace(field(560), viewport)).toEqual({ left: 100, width: 300, maxHeight: 380, bottom: 244 });
  });

  it("keeps a sensible width and stays on screen", () => {
    expect(voiceListPlace(field(100, 900, 200), viewport)).toMatchObject({ left: 752, width: 240 });
    expect(voiceListPlace(field(100, 100, 300), viewport, true)).toMatchObject({ left: 100, width: 300 });
    expect(voiceListPlace(field(100, 0, 900), { width: 400, height: 800 })).toMatchObject({ left: 8, width: 384 });
  });
});
