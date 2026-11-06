import { expect, it } from "vitest";

import en from "./en.json";
import { locales } from "./index";

const SPLIT = ["cloudIntro.badge", "cloudBuy.card.trial", "cloudBuy.pay.planTrial", "usageMeter.confirm.trial", "usageMeter.confirm.trialNoDate", "roomCard.priceTrial"];
const ONE_DAY_DROPS_TODAY = ["usageMeter.confirm.trial", "usageMeter.confirm.trialNoDate", "roomCard.priceTrial"];

it("has both wordings of a trial's length in every language, and only the longer one counts days", () => {
  const packs = Object.entries(locales) as Array<[string, Record<string, string | undefined>]>;
  expect(packs.length).toBeGreaterThan(10);
  for (const [language, pack] of packs) for (const key of SPLIT) {
    expect(pack[`${key}.one`], `${language} ${key}.one`).toBeTruthy();
    expect(pack[`${key}.many`], `${language} ${key}.many`).toBeTruthy();
    expect(pack[`${key}.one`], `${language} ${key}.one`).not.toContain("{days}");
    expect(pack[key], `${language} ${key} is gone`).toBeUndefined();
  }
});

it("keeps what a longer trial read in English, and takes the promise about today out of the shorter one's", () => {
  const english = en as Record<string, string>;
  for (const key of ONE_DAY_DROPS_TODAY) {
    expect(english[`${key}.many`]!.toLowerCase()).toContain("nothing is charged today");
    expect(english[`${key}.one`]!.toLowerCase()).not.toContain("charged");
  }
});

it("takes the promise out of the shorter wording in every language: it is always shorter than the longer one", () => {
  for (const [language, pack] of Object.entries(locales) as Array<[string, Record<string, string>]>) for (const key of ONE_DAY_DROPS_TODAY) {
    expect(pack[`${key}.one`]!.length, `${language} ${key}`).toBeLessThan(pack[`${key}.many`]!.length);
  }
});
