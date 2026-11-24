// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { StorageAnswer } from "@/lib/storage-report";
import { GB, storageReport } from "@/lib/storage-report-fixture";
import { StorageView, type StorageViewProps } from "./StorageView";

const NOW = 1_800_000_000_000 + 3_600_000;
const NAMES: Record<string, string> = { chief: "Chief" };
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function show(answer: StorageAnswer | null, over: Partial<StorageViewProps> = {}) {
  await act(async () => {
    root.render(createElement(StorageView, { answer, fetchedAt: NOW, now: NOW, nameOf: (id: string) => NAMES[id], measuring: false, onMeasure: () => {}, ...over }));
  });
}
const used = (usedGb: number) => ({ totalBytes: 100 * GB, freeBytes: (100 - usedGb) * GB, usedBytes: usedGb * GB });
const summary = () => container.querySelector<HTMLElement>("[data-storage-summary]");
const footnote = () => container.querySelector('[data-settings-block="storage-used"] > p:last-child')?.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);

describe("Settings → Storage", () => {
  it("holds its place with skeleton rows until the answer comes", async () => {
    await show(null);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(summary()).toBeNull();
  });

  it("while the first pass runs: how full it is now, a calm line, and no breakdown or bots yet", async () => {
    await show({ storage: storageReport({ at: null, ageS: null, running: true, volume: null, categories: [], bots: [] }), now: used(40), measureInS: 600 });
    expect(summary()?.dataset.band).toBe("ok");
    expect(summary()?.textContent).toContain("40%full");
    expect(container.textContent).toContain("Measuring what uses this space. This can take a while on a large Cloud.");
    expect(container.querySelector("[data-storage-group]")).toBeNull();
    expect(container.querySelector("[data-storage-bot]")).toBeNull();
    expect(container.textContent).toContain("Measuring…");
    expect(button("Measure again")).toBeUndefined();
  });

  it("normal: the used of total, the three plain groups with Other and the unmeasured rest, the age and Measure again", async () => {
    const measure = vi.fn();
    await show({ storage: storageReport(), now: used(50), measureInS: 0 }, { onMeasure: measure });
    expect(summary()?.dataset.band).toBe("ok");
    expect(summary()?.querySelector("p")?.textContent).toBe("50 GB of 100 GB used");
    expect([...container.querySelectorAll("[data-storage-group]")].map((row) => row.textContent)).toEqual([
      "Your bots' files13 GB", "Conversations and settings6 GB", "Cache and downloads8 GB", "Other2 GB", "Not measured21 GB",
    ]);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
    expect(footnote()).toContain("Measured 1 hour ago.");
    expect(footnote()).toContain("Not measured is the system's own space");
    button("Measure again")!.click();
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("offers no Measure again while the server would refuse one, and no clearing at all", async () => {
    await show({ storage: storageReport(), now: used(30), measureInS: 240 });
    expect(button("Measure again")).toBeUndefined();
    expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([]);
  });

  it.each([[80, "near", "text-warning"], [91, "full", "text-danger"]] as const)("at %i%% says so in the status colour", async (percent, band, ink) => {
    await show({ storage: storageReport(), now: used(percent), measureInS: 0 });
    expect(summary()?.dataset.band).toBe(band);
    expect(summary()?.querySelector(`.${ink}`)?.textContent).toBe(`${percent}%`);
  });

  it("says an over-count plainly, and a failed pass's figures are the one before", async () => {
    const report = storageReport({ failed: true, categories: [{ name: "bot_files", class: "work", bytes: 40 * GB, files: 1 }] });
    await show({ storage: report, now: used(30), measureInS: 0 });
    expect(footnote()).toContain("Some files may be counted twice, so the parts add up to 10 GB more than is used.");
    expect(footnote()).toContain("The last measurement didn't finish, so these figures are from the one before.");
  });

  it("lists the largest bots by name, an unnamed bot as such, deleted bots apart, and says a bot's size counts its cache too", async () => {
    await show({ storage: storageReport(), now: used(30), measureInS: 0 });
    expect([...container.querySelectorAll("[data-storage-bot]")].map((row) => row.textContent)).toEqual([
      "Chief7 GB", "Unnamed bot3 GB", "Deleted bots1.5 GB", "Other bots512 MB",
    ]);
    expect(container.querySelector('[data-settings-block="storage-bots"] > p:last-child')?.textContent)
      .toBe("A bot's size includes its own cache and downloads, also counted under Cache and downloads.");
  });

  it("on a Team Cloud a bot this person isn't shown is a private bot, never its name", async () => {
    await show({ storage: storageReport(), now: used(30), measureInS: 0 }, { team: true });
    expect([...container.querySelectorAll("[data-storage-bot]")].map((row) => row.textContent)).toEqual([
      "Chief7 GB", "Private bot3 GB", "Deleted bots1.5 GB", "Other bots512 MB",
    ]);
  });

  it("the faint groups' legend dots carry a ring, so they read on a dark skin", async () => {
    await show({ storage: storageReport(), now: used(50), measureInS: 0 });
    const dot = (key: string) => container.querySelector(`[data-storage-group="${key}"] > span`)?.className ?? "";
    expect(dot("other")).toContain("var(--color-ink-tertiary)");
    expect(dot("unmeasured")).toContain("var(--color-ink-tertiary)");
  });
});
