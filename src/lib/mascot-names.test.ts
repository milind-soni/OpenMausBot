import { afterEach, describe, expect, it } from "vitest";

import { BOT_BODY_IDS } from "../../shared/bot-body";
import { en, locales } from "@/locales";
import { setLocale } from "./i18n";
import { MAUS_COLOR_NAMES, PICKABLE_STATES } from "./mascot";
import { bodyName, colorName, expressionName, silhouetteName } from "./mascot-names";

afterEach(() => {
  setLocale("en");
});

describe("mascot names", () => {
  const keys = [
    ...BOT_BODY_IDS.map((id) => `mascot.body.${id}`),
    ...MAUS_COLOR_NAMES.map((color) => `mascot.color.${color}`),
    ...PICKABLE_STATES.map((state) => `mascot.expression.${state}`),
  ];

  it("has an English and a Brazilian Portuguese name for every body, colour and face the pickers show", () => {
    for (const key of keys) {
      expect(Object.hasOwn(en, key), key).toBe(true);
      expect(Object.hasOwn(locales["pt-br"]!, key), key).toBe(true);
    }
  });

  it("reads the names in the app language", () => {
    expect([bodyName("pumpkin"), colorName("red"), expressionName("happy"), silhouetteName("Ghost")]).toEqual(["Pumpkin", "red", "happy", "Ghost"]);
    setLocale("pt-br");
    expect([bodyName("pumpkin"), colorName("red"), expressionName("happy"), silhouetteName("Ghost")]).toEqual(["Abóbora", "vermelha", "feliz", "Fantasma"]);
  });

  it("falls back to the id or name it was given when the catalog has none", () => {
    expect(expressionName("unknown-face")).toBe("unknown-face");
    expect(silhouetteName("Not a body")).toBe("Not a body");
  });
});
