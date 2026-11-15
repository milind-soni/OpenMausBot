import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import en from "./en.json";

// The composer's slash menu lists the built-in commands with a short description. A language that translates
// some of those descriptions must translate all of them, or one command reads in English in an otherwise
// translated menu (reported for /burst in Chinese).
const DIR = fileURLToPath(new URL(".", import.meta.url));
const packs = Object.fromEntries(
  readdirSync(DIR)
    .filter((name) => /^[a-z-]+\.json$/.test(name) && name !== "en.json" && name !== "source-hashes.json")
    .map((name) => [name.slice(0, -5), JSON.parse(readFileSync(`${DIR}${name}`, "utf8")) as Record<string, string>]),
);
const COMMAND_DESCRIPTIONS = Object.keys(en).filter((key) => /^composer\.command\.\w+Desc$/.test(key));

it("translates /burst's description wherever the other command descriptions are translated", () => {
  expect(COMMAND_DESCRIPTIONS).toContain("composer.command.burstDesc");
  const missing = Object.entries(packs)
    .filter(([, pack]) => Object.hasOwn(pack, "composer.command.goalDesc") && !Object.hasOwn(pack, "composer.command.burstDesc"))
    .map(([code]) => code);
  expect(missing).toEqual([]);
});

it("shows the whole /burst card in Chinese", () => {
  const burstKeys = Object.keys(en).filter(
    (key) => /^(?:server\.)?burst\./.test(key) || key === "composer.command.burstDesc" || key === "activity.tool.team.burst",
  );
  expect(burstKeys.length).toBeGreaterThan(30);
  for (const code of ["zh", "zh-tw"]) {
    expect(burstKeys.filter((key) => !Object.hasOwn(packs[code]!, key)), code).toEqual([]);
  }
});
