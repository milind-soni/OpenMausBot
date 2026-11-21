import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const storeFixture = vi.hoisted(() => ({ config: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: storeFixture.config }, dispatch: vi.fn() }) };
});

import { ShareLearnedSkillsSettings } from "./ShareLearnedSkillsSettings";

const buttonsDisabled = () => [...renderToStaticMarkup(createElement(ShareLearnedSkillsSettings)).matchAll(/<button[^>]*role="radio"[^>]*>/g)]
  .map(([button]) => button.includes('disabled=""'));

describe("share learned skills", () => {
  it("cannot be changed, by mouse or keyboard, while skill authoring is off", () => {
    storeFixture.config = { features: { skillsLibrary: true, skillAuthoring: false } };
    expect(buttonsDisabled()).toEqual([true, true, true]);
  });

  it("can be changed while skill authoring is on", () => {
    storeFixture.config = { features: { skillsLibrary: true } };
    expect(buttonsDisabled()).toEqual([false, false, false]);
  });
});
