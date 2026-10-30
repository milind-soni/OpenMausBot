import { describe, expect, it } from "vitest";

import { FIRST_HOUR_LANGUAGES, firstHourWords, roundedTime } from "./first-hour-words.ts";

const LOCALES = ["de", "es", "fr", "hi", "it", "ja", "ko", "pl", "pt-br", "ru", "tr", "uk", "vi", "zh", "zh-tw"];

describe("the first hour's words", () => {
  it("come in English and every language the app ships", () => {
    expect([...FIRST_HOUR_LANGUAGES].sort()).toEqual(["en", ...LOCALES].sort());
  });

  it("say every line in each language, with the name, the counts and the time in it", () => {
    for (const language of FIRST_HOUR_LANGUAGES) {
      const w = firstHourWords(language);
      const english = language !== "en" ? firstHourWords("en") : null;
      for (const line of [w.connect, w.connected, w.briefOn, w.phoneTitle, w.phoneBody, w.phoneButton, w.firstLookReady, w.firstBriefReady]) {
        expect(line.trim(), language).not.toBe("");
        if (english) expect([english.connect, english.connected, english.briefOn, english.phoneTitle, english.phoneBody, english.phoneButton, english.firstLookReady, english.firstBriefReady], language).not.toContain(line);
      }
      expect(w.greeting("Sam", "MausBot"), language).toContain("Sam");
      expect(w.greeting(undefined, "MausBot"), language).toContain("MausBot");
      expect(w.greeting(undefined, "MausBot"), language).not.toContain("undefined");
      expect(w.briefOn, language).toMatch(/8/);
      const done = w.list([w.sorted(40), w.drafted(6), w.prepped(4)]);
      for (const n of ["40", "6", "4"]) expect(done, language).toContain(n);
      expect(w.recap(done, w.time(110)), language).toContain("2");
      expect(w.overnight(w.list([w.sorted(1)])), language).toContain("1");
      expect(w.routines(3), language).toContain("3");
    }
  });

  it("count in English the way a person does", () => {
    const w = firstHourWords("en");
    expect(w.list([w.sorted(1), w.drafted(1), w.prepped(1)])).toBe("sorted 1 email, drafted 1 reply and prepped 1 meeting");
    expect(w.recap(w.list([w.sorted(40), w.drafted(6), w.prepped(4)]), w.time(110))).toBe("So far I've sorted 40 emails, drafted 6 replies and prepped 4 meetings: about 2 hours back.");
    expect(w.overnight(w.list([w.sorted(23), w.drafted(2)]))).toBe("While you slept, I sorted 23 emails and drafted 2 replies.");
    expect([12, 47, 60, 89, 90, 151].map((minutes) => w.time(minutes))).toEqual(["about 10 minutes", "about 45 minutes", "about an hour", "about an hour", "about 2 hours", "about 3 hours"]);
  });

  it("use the plural forms of Russian, Ukrainian and Polish", () => {
    expect([1, 3, 5, 21].map((n) => firstHourWords("ru").sorted(n))).toEqual(["разобрано 1 письмо", "разобрано 3 письма", "разобрано 5 писем", "разобрано 21 письмо"]);
    expect([1, 2, 5].map((n) => firstHourWords("uk").prepped(n))).toEqual(["підготовлено 1 зустріч", "підготовлено 2 зустрічі", "підготовлено 5 зустрічей"]);
    expect([1, 4, 12].map((n) => firstHourWords("pl").drafted(n))).toEqual(["napisano 1 szkic odpowiedzi", "napisano 4 szkice odpowiedzi", "napisano 12 szkiców odpowiedzi"]);
  });

  it("say the hours saved in the case \"about\" takes", () => {
    expect([firstHourWords("ru").time(110), firstHourWords("uk").time(110), firstHourWords("pl").time(110), firstHourWords("pl").time(300)])
      .toEqual(["около 2 часов", "близько 2 годин", "około 2 godzin", "około 5 godzin"]);
  });

  it("fall back to English for a language it does not have, and to the parent for a regional one", () => {
    expect(firstHourWords("sv").briefOn).toBe(firstHourWords("en").briefOn);
    expect(firstHourWords("de-AT").briefOn).toBe(firstHourWords("de").briefOn);
    expect(firstHourWords("pt").briefOn).toBe(firstHourWords("pt-br").briefOn);
  });

  it("round time saved down to what a person would say, never below five minutes", () => {
    expect(roundedTime(1)).toEqual({ unit: "minutes", n: 5 });
    expect(roundedTime(57)).toEqual({ unit: "minutes", n: 55 });
    expect(roundedTime(59)).toEqual({ unit: "hours", n: 1 });
    expect(roundedTime(61)).toEqual({ unit: "hours", n: 1 });
    expect(roundedTime(150)).toEqual({ unit: "hours", n: 3 });
  });
});
