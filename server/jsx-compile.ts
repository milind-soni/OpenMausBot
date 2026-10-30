import { transform } from "sucrase";

import { JSX_PAGE_MODULES, JSX_TRANSFORM_OPTIONS } from "../shared/app-frame/jsx-page.ts";

export type JsxCompiled = { ok: true; code: string } | { ok: false; error: string };

/** The frame's own transform, run here so a page that cannot work is refused to the bot at once, with where. */
export function compileJsxPage(source: string): JsxCompiled {
  let code: string;
  try {
    code = transform(source, { ...JSX_TRANSFORM_OPTIONS, transforms: [...JSX_TRANSFORM_OPTIONS.transforms] }).code;
  } catch (error) {
    const line = (error as { loc?: { line?: number } }).loc?.line;
    const message = String((error as Error)?.message ?? error).replace(/\s*\(\d+:\d+\)$/, "");
    const where = typeof line === "number" ? `line ${line}: ` : "";
    return { ok: false, error: `jsx: ${where}${message}. Fix it and send the whole file again.` };
  }
  const refused = [...new Set([...code.matchAll(/\brequire\((["'])([^"']+)\1\)/g)].map((match) => match[2]!))]
    .filter((name) => !JSX_PAGE_MODULES.includes(name));
  if (refused.length) return { ok: false, error: `jsx: imports ${refused.join(", ")}; a page can import only ${JSX_PAGE_MODULES.join(", ")}.` };
  return { ok: true, code };
}
