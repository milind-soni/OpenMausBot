import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPersonLanguages, PERSON_LANGUAGES_FILE } from "./person-languages.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(configured?: string, dataDir = mkdtempSync(join(tmpdir(), "omb-person-languages-"))) {
  dirs.push(dataDir);
  let clock = 1_000;
  const languages = createPersonLanguages({ dataDir, configured: () => configured, now: () => clock });
  return { languages, dataDir, tick: () => { clock += 1_000; } };
}

describe("the language a line for a person is written in", () => {
  it("is the one their app shows, else the place's: the one set here, else the one most people's apps show", () => {
    const { languages, tick } = fixture();
    expect(languages.forLine()).toBeUndefined();
    languages.heard("ada", "de");
    tick();
    languages.heard("ben", "en");
    tick();
    languages.heard("cy", "de");
    expect(languages.forLine("ben")).toBe("en");
    expect(languages.forLine("ada")).toBe("de");
    expect(languages.forLine("someone-new")).toBe("de");
    expect(languages.forLine()).toBe("de");
    const set = fixture("fr");
    set.languages.heard("ada", "de");
    expect(set.languages.forLine("ada")).toBe("de");
    expect(set.languages.forLine()).toBe("fr");
  });

  it("breaks a tie with the language heard last, and follows a person who changes theirs", () => {
    const { languages, tick } = fixture();
    languages.heard("ada", "de");
    tick();
    languages.heard("ben", "es");
    expect(languages.forLine()).toBe("es");
    tick();
    languages.heard("ada", "de");
    expect(languages.forLine()).toBe("de");
    languages.heard("ada", "pt-BR");
    expect(languages.forLine("ada")).toBe("pt-br");
  });

  it("keeps what it heard across a restart, and ignores what is not a language tag", () => {
    const first = fixture();
    first.languages.heard("ada", "de");
    first.languages.heard("ben", "<script>");
    first.languages.heard("", "fr");
    const again = fixture(undefined, first.dataDir);
    expect(again.languages.forLine("ada")).toBe("de");
    expect(again.languages.forLine("ben")).toBe("de");
    expect(Object.keys(JSON.parse(readFileSync(join(first.dataDir, PERSON_LANGUAGES_FILE), "utf8")).people)).toEqual(["ada"]);
  });

  it("starts fresh from a file it cannot read", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-person-languages-"));
    writeFileSync(join(dataDir, PERSON_LANGUAGES_FILE), "{ not json");
    const { languages } = fixture("it", dataDir);
    expect(languages.forLine("ada")).toBe("it");
    languages.heard("ada", "de");
    expect(languages.forLine("ada")).toBe("de");
  });
});
