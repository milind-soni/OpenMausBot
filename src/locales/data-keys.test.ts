// The Data surface's strings have been rewritten twice (#2544, #2596) and
// each pass left keys behind. Every data.* key must still be read somewhere:
// as a literal t("data.…") or map value, or through a template on its parent
// (t(`data.view.${mode}`)).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import en from "./en.json";

const root = fileURLToPath(new URL("..", import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "locales" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

it("keeps no Data string that nothing reads", () => {
  const code = sources(root).join("\n");
  const unread = Object.keys(en).filter((key) => key.startsWith("data.")).filter((key) => {
    const parent = key.slice(0, key.lastIndexOf(".") + 1);
    return !code.includes(`"${key}"`) && !code.includes(`\`${parent}\${`);
  });
  expect(unread).toEqual([]);
});
