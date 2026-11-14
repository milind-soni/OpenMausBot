// @vitest-environment happy-dom
// The shell's runtime runs here as written, against the real React, ReactDOM and Sucrase from node_modules in place
// of the CDN copies the page loads.
import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
import { transform } from "sucrase";
import { afterEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { BOT_HTML_CDNS } from "./csp.ts";
import {
  JSX_PAGE_IMPORTS, JSX_PAGE_LIBRARIES, JSX_PAGE_MODULES, JSX_PAGE_SUCRASE, JSX_PAGE_TAILWIND, JSX_RUNTIME_SOURCE, JSX_TRANSFORM_OPTIONS,
  jsxPageHtml, jsxPublishedHtml, scriptSafe,
} from "./jsx-page.ts";

type Problem = { kind: string; message: string; line: number | null; excerpt: string };
type Runtime = (env: Record<string, unknown>) => Promise<unknown>;
const runtime = new Function(`return ${JSX_RUNTIME_SOURCE}`)() as Runtime;

const fakeEcharts = {
  made: [] as Array<{ theme: string | undefined; options: unknown[]; disposed: boolean }>,
  init(_box: Element, theme?: string) {
    const chart = { theme, options: [] as unknown[], disposed: false };
    fakeEcharts.made.push(chart);
    return { setOption: (option: unknown) => chart.options.push(option), resize: () => {}, dispose: () => { chart.disposed = true; } };
  },
};

const LIBRARIES: Record<string, () => Promise<unknown>> = {
  react: async () => React,
  "react-dom/client": async () => ReactDOMClient,
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  "lucide-react": () => import("lucide-react"),
  echarts: async () => fakeEcharts,
  sucrase: async () => ({ transform }),
};

const roots: Array<{ unmount(): void }> = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  delete (window as { mausbot?: unknown }).mausbot;
  fakeEcharts.made = [];
});

async function start(source: string, more: Record<string, unknown> = {}) {
  document.body.innerHTML = "<div id=\"mausbot-root\"></div>";
  const problems: Problem[] = [];
  const loads: string[] = [];
  const root = await runtime({
    doc: document, win: window, title: "Pricing", source,
    load: (name: string) => { loads.push(name); return LIBRARIES[name] ? LIBRARIES[name]!() : Promise.reject(new TypeError(`no ${name}`)); },
    onProblem: (problem: Problem) => problems.push(problem),
    ...more,
  }) as { unmount(): void } | null;
  if (root) roots.push(root);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { problems, loads, overlay: document.querySelector<HTMLElement>("[data-page-problem]"), rendered: document.getElementById("mausbot-root")! };
}

const PRICING = `import { useState } from "react";
import { Check } from "lucide-react";
type Plan = { name: string; price: number };
const plans: Plan[] = [{ name: "Starter", price: 15 }, { name: "Pro", price: 49 }];
export default function Pricing() {
  const [picked, setPicked] = useState<string | null>(null);
  return <main className="p-6">{plans.map((plan) => <section key={plan.name} data-plan={plan.name}>
    <h2>{plan.name}</h2><p>\${plan.price}</p><button onClick={() => setPicked(plan.name)}><Check size={14} /> Choose</button>
  </section>)}{picked && <p id="picked">{picked}</p>}</main>;
}`;

describe("a jsx page in the shell", () => {
  it("transpiles the file with Sucrase, loads only what it imports, and renders its default export", async () => {
    const { problems, loads, rendered, overlay } = await start(PRICING);
    expect(problems).toEqual([]);
    expect(overlay).toBeNull();
    expect(loads).toEqual(["sucrase", "react", "react-dom/client", "react/jsx-runtime", "lucide-react"]);
    expect([...rendered.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["Starter", "Pro"]);
    expect(rendered.querySelectorAll("svg")).toHaveLength(2);
    rendered.querySelectorAll("button")[1]!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rendered.querySelector("#picked")?.textContent).toBe("Pro");
  });

  it("shows a syntax error as a readable overlay with the line, and tells the bot through the page's context", async () => {
    const setContext = vi.fn(async () => {});
    (window as { mausbot?: unknown }).mausbot = { send: vi.fn(), open: vi.fn(), setContext };
    const { problems, overlay } = await start("export default function Page() {\n  const total = ;\n  return <p>{total}</p>;\n}");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "syntax", message: "Unexpected token", line: 2 });
    expect(problems[0]!.excerpt).toBe("  1 | export default function Page() {\n> 2 |   const total = ;\n  3 |   return <p>{total}</p>;\n  4 | }");
    expect(overlay?.getAttribute("role")).toBe("alert");
    expect(overlay?.textContent).toContain("This page's code doesn't read right");
    expect(overlay?.querySelector("pre")?.textContent).toContain("const total = ;");
    expect(setContext).toHaveBeenCalledTimes(1);
    expect(setContext.mock.calls[0]![0]).toBe("The page “Pricing” shows an error instead of its content. Unexpected token (line 2)\n" + problems[0]!.excerpt);
  });

  it("names an import a page cannot load, and says which it can", async () => {
    const { problems, loads } = await start("import axios from \"axios\";\nexport default function Page() { return <p>{String(axios)}</p>; }");
    expect(problems[0]).toMatchObject({ kind: "import", message: expect.stringContaining("It imports axios. A page can import only react,") });
    expect(loads).toEqual(["sucrase"]);
  });

  it("says the file needs a default export", async () => {
    const { problems } = await start("export const Page = () => <p>x</p>;\nexport default undefined;");
    expect(problems[0]).toMatchObject({ kind: "export" });
  });

  it("catches an error while rendering", async () => {
    const { problems, overlay } = await start("export default function Page() { const data: any = null; return <p>{data.total}</p>; }");
    expect(problems[0]).toMatchObject({ kind: "render" });
    expect(overlay?.textContent).toContain("This page stopped with an error");
  });

  it("says it needs the internet when the libraries cannot be fetched", async () => {
    const { problems, overlay } = await start(PRICING, { load: () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")) });
    expect(problems[0]).toMatchObject({ kind: "offline", message: expect.stringContaining("needs the internet") });
    expect(overlay?.getAttribute("data-page-problem")).toBe("offline");
  });

  it("gives the page mausbot's Chart and useTheme, drawing ECharts in the chat's theme", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const source = `import { Chart, useTheme } from "mausbot";
export default function Page() { const theme = useTheme(); return <div><p id="theme">{theme}</p><Chart label="Sales" option={{ series: [{ type: "bar", data: [1, 2] }] }} /></div>; }`;
    const { problems, loads, rendered } = await start(source);
    expect(problems).toEqual([]);
    expect(loads).toContain("echarts");
    expect(rendered.querySelector("#theme")?.textContent).toBe("dark");
    expect(rendered.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("Sales");
    expect(fakeEcharts.made[0]).toMatchObject({ theme: "dark", options: [{ backgroundColor: "transparent", series: [{ type: "bar", data: [1, 2] }] }] });
  });

  it("runs a published page's transpiled code without loading the compiler", async () => {
    const compiled = transform(PRICING, { ...JSX_TRANSFORM_OPTIONS, transforms: [...JSX_TRANSFORM_OPTIONS.transforms] }).code;
    const page = new Function("require", "module", "exports", compiled);
    const { problems, loads, rendered } = await start("", { page });
    expect(problems).toEqual([]);
    expect(loads).not.toContain("sucrase");
    expect(rendered.querySelectorAll("section")).toHaveLength(2);
  });
});

describe("the shell's HTML", () => {
  it("pins every library to an exact version on a CDN the page's policy allows", () => {
    const urls = [...Object.values(JSX_PAGE_IMPORTS), JSX_PAGE_SUCRASE, JSX_PAGE_TAILWIND];
    for (const url of urls) {
      expect(BOT_HTML_CDNS.some((cdn) => url.startsWith(`${cdn}/`)), url).toBe(true);
      expect(url, url).toMatch(/\/npm\/(@[\w-]+\/)?[\w.-]+@\d+\.\d+\.\d+\//);
    }
    expect(JSX_PAGE_LIBRARIES.sucrase).toBe(packageJson.dependencies.sucrase);
    expect(JSX_PAGE_MODULES).toEqual(["react", "react/jsx-runtime", "react-dom", "react-dom/client", "lucide-react", "echarts", "mausbot"]);
  });

  it("carries the file as JSON no script element can be closed by, with the import map and Tailwind ahead of it", () => {
    const html = jsxPageHtml({ title: "A <b>title</b>", source: "export default () => <p>{\"</script><!--\"}</p>;" });
    const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(html)![1]!);
    expect(map.imports).toMatchObject({
      ...JSX_PAGE_IMPORTS, sucrase: JSX_PAGE_SUCRASE, "https://cdn.jsdelivr.net/npm/react@%5E19.3.0/+esm": JSX_PAGE_IMPORTS.react,
      "https://cdn.jsdelivr.net/npm/@jridgewell/sourcemap-codec@1.5.3/+esm": "https://cdn.jsdelivr.net/npm/@jridgewell/sourcemap-codec@1.5.3/dist/sourcemap-codec.mjs",
    });
    expect(html).toContain("<title>A &lt;b&gt;title&lt;/b&gt;</title>");
    expect(html.match(/<\/script>/g)).toHaveLength(3);
    expect(html).not.toContain("<!--");
    expect(html.indexOf("importmap")).toBeLessThan(html.indexOf(JSX_PAGE_TAILWIND));
    expect(html.indexOf(JSX_PAGE_TAILWIND)).toBeLessThan(html.indexOf("type=\"module\""));
  });

  it("publishes as static HTML: the transpiled code in a plain function, the theme colours, and no compiler", () => {
    const compiled = "\"use strict\";exports.default = function () { return \"</script>\"; };";
    const html = jsxPublishedHtml({ title: "Pricing", compiled });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("window.__mausbotPage=function(require,module,exports){\"use strict\";exports.default = function () { return \"<\\/script>\"; };");
    expect(html).toContain("--color-text-primary:light-dark(");
    expect(html).not.toContain("source:");
    expect(html.match(/<\/script>/g)).toHaveLength(4);
    expect(scriptSafe("a<!--b</SCRIPT>")).toBe("a<\\!--b<\\/SCRIPT>");
  });
});
