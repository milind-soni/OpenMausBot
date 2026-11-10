import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { announcementProblems, MAX_DAYS_AHEAD, MAX_FILE_BYTES, MAX_IMAGE_BYTES, schemaText } from "./check-announcements.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const committed = read("announcements/announcements.json");
const example = JSON.parse(read("scripts/testing/fixtures/announcements.example.json"));
const NOW = Date.parse("2026-12-01T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const noPictures = () => null;
const problems = (value, options = {}) => announcementProblems(typeof value === "string" ? value : JSON.stringify(value, null, 2), { now: NOW, fileSize: noPictures, ...options });
const tip = (extra = {}) => ({ ...structuredClone(example.cards[0]), ...extra });
const withCards = (...cards) => ({ ...structuredClone(example), cards });

describe("the committed file", () => {
  it("is valid", () => {
    expect(announcementProblems(committed)).toEqual([]);
  });

  it("has its JSON Schema beside it, up to date with the app's own rules", () => {
    expect(read("announcements/announcements.schema.json"), "run node scripts/check-announcements.mjs --write-schema").toBe(schemaText());
  });

  it("the JSON Schema an editor reads takes the committed file and the documented examples", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    // ajv-formats is CommonJS: the plugin is the module and its .default.
    (formats.default ?? formats)(ajv);
    const validate = ajv.compile(JSON.parse(schemaText()));
    expect(validate(JSON.parse(committed)), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(withCards(tip({ kind: "survey" })))).toBe(false);
  });
});

describe("what the check refuses", () => {
  it("the documented examples pass", () => {
    expect(problems(example)).toEqual([]);
  });

  it("malformed JSON, and a file too large for the corner", () => {
    expect(problems("{ not json")).toEqual(["the file is not valid JSON"]);
    expect(problems(" ".repeat(MAX_FILE_BYTES + 1))).toEqual([`the file is larger than ${MAX_FILE_BYTES} bytes`]);
  });

  it("a card the app could not show: an unknown kind or action, an http link, overflowing text, a typo'd field", () => {
    for (const card of [tip({ kind: "survey" }), tip({ primary: { label: "Go", action: { open: "billing" } } }), tip({ primary: { label: "Go", action: { open_url: "http://example.com" } } }),
      tip({ title: "x".repeat(61) }), tip({ titel: "Typo" }), tip({ ends: undefined })]) expect(problems(withCards(card)), JSON.stringify(card)).toHaveLength(1);
  });

  it("two cards with one id", () => {
    expect(problems(withCards(tip(), tip()))[0]).toMatch(/used twice/);
  });

  it("a sponsor's card with no label saying it is one", () => {
    const sponsor = { ...structuredClone(example.cards[1]) };
    delete sponsor.label;
    expect(problems(withCards(sponsor))).toEqual([`${sponsor.id}: a sponsor's card needs a label, such as "Sponsor", so people can tell it is one`]);
  });

  it("an end more than MAX_DAYS_AHEAD days away, though not an end already past", () => {
    expect(problems(withCards(tip({ ends: new Date(NOW + (MAX_DAYS_AHEAD + 1) * DAY).toISOString() })))[0]).toMatch(/days away/);
    expect(problems(withCards(tip({ ends: "2026-11-02T00:00:00Z" })))).toEqual([]);
  });

  it("a picture that is not in the repository, or too large", () => {
    const pictured = tip({ image: { url: "https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/announcements/images/tip.png", alt: "A tip" } });
    expect(problems(withCards(pictured))).toEqual(["tip-first-api-key: the picture announcements/images/tip.png is not in the repository"]);
    expect(problems(withCards(pictured), { fileSize: () => MAX_IMAGE_BYTES + 1 })[0]).toMatch(/larger than/);
    expect(problems(withCards(pictured), { fileSize: () => 40_000 })).toEqual([]);
  });

  it("a change that does not move updatedAt forward", () => {
    const before = JSON.stringify(example, null, 2);
    const edited = { ...structuredClone(example), cards: [tip({ title: "A new title" })] };
    expect(problems(edited, { previous: before })[0]).toMatch(/updatedAt did not move forward/);
    expect(problems({ ...edited, updatedAt: "2026-12-01T09:30:00Z" }, { previous: before })).toEqual([]);
    expect(problems(example, { previous: before }), "an unchanged file").toEqual([]);
  });
});
