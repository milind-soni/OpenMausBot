import { describe, expect, it } from "vitest";
import { HEAR_LANGUAGES, languageOptions } from "./VoiceHearingSetting";

describe("languageOptions", () => {
  it("offers the listed languages once each", () => {
    const codes = languageOptions("es").map((option) => option.code);
    expect(codes).toHaveLength(HEAR_LANGUAGES.length);
    expect(codes.filter((code) => code === "es")).toHaveLength(1);
  });

  it("adds a saved language the list does not offer, so the picker shows it", () => {
    expect(languageOptions("cy").map((option) => option.code)).toContain("cy");
    expect(languageOptions("spa").map((option) => option.code)).toContain("spa");
  });

  it("adds nothing for automatic detection", () => {
    expect(languageOptions("")).toHaveLength(HEAR_LANGUAGES.length);
  });
});
