// The app loads a language's pack before it shows it (loadLocale); tests switch languages synchronously, so every
// pack is here, read the first time a test asks for it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { localePacks, locales, type LocalePack } from "../locales/index.ts";

const folder = join(dirname(fileURLToPath(import.meta.url)), "..", "locales");
const read = new Map<string, LocalePack>();
const pack = (name: string): LocalePack => {
  let found = read.get(name);
  if (!found) read.set(name, found = JSON.parse(readFileSync(join(folder, `${name}.json`), "utf8")) as LocalePack);
  return found;
};
for (const [tag, name] of Object.entries(localePacks)) {
  if (!(tag in locales)) Object.defineProperty(locales, tag, { configurable: true, enumerable: true, get: () => pack(name) });
}
