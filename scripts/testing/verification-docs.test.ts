// Verification recipes are followed by hand, so nothing else notices when a
// command, file, route or link they cite stops existing. This reads every
// recipe under docs/verification and checks each citation against the tree.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HELP } from "../control-omb.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOCS = join(ROOT, "docs", "verification");
const recipes = readdirSync(DOCS).filter((name) => name.endsWith(".md")).sort();
const text = (recipe: string) => readFileSync(join(DOCS, recipe), "utf8");
// Paths inside external links belong to other repositories.
const withoutUrls = (markdown: string) => markdown.replace(/https?:\/\/\S+/g, " ");
const cited = (pattern: RegExp) => {
  const hits: string[] = [];
  for (const recipe of recipes) {
    for (const match of withoutUrls(text(recipe)).matchAll(pattern)) hits.push(`${recipe}: ${match[1]!}`);
  }
  return hits;
};
const target = (hit: string) => hit.slice(hit.indexOf(": ") + 2);

// The verbs `help` prints, minus the shell line under "isolated fixture".
const helpVerbs = new Set([...HELP.matchAll(/^ {2}([a-z][\w-]*)(?= |$)/gm)].map((match) => match[1]!).filter((verb) => verb !== "node"));
helpVerbs.add("help");

const serverSource = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
const hooksSource = readFileSync(join(ROOT, "server", "webhook-ingress.ts"), "utf8");
// server/index.ts matches routes two ways: `path === "/api/x"` and
// `path.match(/^\/api\/x\/(a|b)$/)`. Collect the regex form too.
const routePatterns = [...serverSource.matchAll(/\/(\^\\\/api\\\/(?:\[(?:[^\]\\]|\\.)*\]|[^/\\\n[]|\\.)*)\/[a-z]*/g)].map((match) => new RegExp(match[1]!));
const PLACEHOLDER = /^(ID|:[\w-]+|<[^>]+>|\{[^}]+\})$/;

const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/\s+/g, "-");

describe("docs/verification recipes cite things that exist", () => {
  it("use control:omb verbs that help lists", () => {
    const used = cited(/pnpm control:omb ([a-z][\w-]*)/g);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((hit) => !helpVerbs.has(target(hit)))).toEqual([]);
    // the launcher form may also name `launch`, which pnpm cannot run
    const direct = cited(/scripts\/control-omb\.ts ([a-z][\w-]*)/g);
    expect(direct.filter((hit) => target(hit) !== "launch" && !helpVerbs.has(target(hit)))).toEqual([]);
  });

  it("cite source files that exist", () => {
    const refs = cited(/(?<![\w/.-])((?:scripts|server|src|shared|electron|companion|enterprise)\/[\w./-]+\.(?:ts|tsx|mjs|cjs|py))(?![\w/])/g);
    expect(refs.length).toBeGreaterThan(50);
    expect([...new Set(refs.filter((hit) => !existsSync(join(ROOT, target(hit)))))]).toEqual([]);
  });

  it("cite test files that exist", () => {
    const refs = cited(/(?<![\w/.-])([\w./-]+\.test\.(?:ts|mjs))(?![\w/])/g);
    expect(refs.length).toBeGreaterThan(20);
    expect([...new Set(refs.filter((hit) => !existsSync(join(ROOT, target(hit)))))]).toEqual([]);
  });

  it("cite API routes the server registers", () => {
    const refs = cited(/(?<!\w)(\/(?:api|hooks)\/[\w./:{}<>-]+)/g);
    expect(refs.length).toBeGreaterThan(5);
    const registered = (route: string) => {
      const path = route.replace(/[.,;:]+$/, "");
      const source = path.startsWith("/hooks/") ? hooksSource : serverSource;
      const segments = path.split("/").slice(1);
      const literal = segments.findIndex((segment) => PLACEHOLDER.test(segment));
      if (literal === -1) return source.includes(`"${path}"`) || routePatterns.some((pattern) => pattern.test(path));
      // a placeholder path is known by its first two segments
      const prefix = `/${segments.slice(0, Math.min(2, literal)).join("/")}`;
      return source.includes(`"${prefix}`) || source.includes(`${prefix}/`)
        || routePatterns.some((pattern) => pattern.test(segments.map((segment) => PLACEHOLDER.test(segment) ? "x-1" : segment).join("/").replace(/^/, "/")));
    };
    expect([...new Set(refs.filter((hit) => !registered(target(hit))))]).toEqual([]);
  });

  it("are all reachable from README.md", () => {
    const linked = new Set([...text("README.md").matchAll(/\]\(([^)#\s]+\.md)/g)].map((match) => match[1]!));
    expect(recipes.filter((recipe) => recipe !== "README.md" && !linked.has(recipe))).toEqual([]);
  });

  it("link to files and headings that exist", () => {
    const broken: string[] = [];
    for (const recipe of recipes) {
      for (const [, link] of text(recipe).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^(https?:|mailto:|#)/.test(link!)) continue;
        const [file, anchor] = link!.split("#");
        const resolved = resolve(DOCS, file!);
        if (!existsSync(resolved)) { broken.push(`${recipe}: ${link}`); continue; }
        if (anchor && resolved.endsWith(".md")) {
          const headings = [...readFileSync(resolved, "utf8").matchAll(/^#+\s+(.+)$/gm)].map((match) => slug(match[1]!));
          if (!headings.includes(anchor)) broken.push(`${recipe}: ${link} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
