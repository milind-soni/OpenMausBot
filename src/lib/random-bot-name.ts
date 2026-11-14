import female from "../data/given-names/female.json";
import male from "../data/given-names/male.json";

export type GivenNameList = "female" | "male";
const normalize = (name: string) => name.trim().toLowerCase();
const uniqueNames = (names: string[]) => [...new Map(names.map(name => [normalize(name), name.trim()])).values()];
const pools = { female: uniqueNames(female), male: uniqueNames(male) };

export function randomBotName(list: GivenNameList, current: string, existingNames: string[]): string {
  const used = new Set(existingNames.map(normalize));
  used.add(normalize(current));
  let choices = pools[list].filter(name => !used.has(normalize(name)));
  if (!choices.length) choices = pools[list].filter(name => normalize(name) !== normalize(current));
  return choices[Math.floor(Math.random() * choices.length)];
}
