// Themes and the bots' guide rely on these hooks staying in the app's source; rename one in shared/theme.ts too.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { THEME_HOOKS } from "../../../shared/theme";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const source = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
  .map((file) => readFileSync(join(SRC, file), "utf8"))
  .join("\n");

/** How a hook is written in the source: `data-look="x"` or a `"x"` beside `data-look=`, or a `role="x"`. */
function written(selector: string): RegExp | null {
  const look = /^\[data-look="([a-z-]+)"\]$/.exec(selector)?.[1];
  if (look) return new RegExp(`data-look=(?:"${look}"|\\{[^}\\n]*"${look}")`);
  const role = /^\[role="([a-z]+)"\]$/.exec(selector)?.[1];
  return role ? new RegExp(`role="${role}"`) : null;
}

it.each(THEME_HOOKS.map((hook) => hook.selector))("%s is still in the app", (selector) => {
  const pattern = written(selector);
  if (pattern) expect(source).toMatch(pattern);
  else expect(selector).toMatch(/^(button|input, textarea|::-webkit-scrollbar, ::-webkit-scrollbar-thumb)$/);
});
