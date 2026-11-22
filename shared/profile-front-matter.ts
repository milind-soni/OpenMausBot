import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, visit, type Document, type Node } from "yaml";

import { findInvisibles } from "./profile-leaks.ts";

export const PROFILE_MAX_PROBLEMS = 200;

/** One thing wrong with a profile folder. `line` is the file's own line number, front matter included. */
export interface ProfileProblem {
  file: string;
  line?: number;
  field?: string;
  message: string;
}

/** A problem as one plain sentence: `areas/bi/bots/analyst.md, line 9: model must be INSTANCE/MODEL…`. */
export function problemSentence(problem: ProfileProblem): string {
  const where = problem.line ? `${problem.file}, line ${problem.line}` : problem.file;
  return `${where}: ${problem.field ? `${problem.field} ` : ""}${problem.message}`;
}

export interface ParsedDoc {
  file: string;
  data: Record<string, unknown>;
  body: string;
  lineOf(path: readonly (string | number)[], key?: boolean): number | undefined;
}

export class Problems {
  readonly list: ProfileProblem[] = [];
  readonly warnings: ProfileProblem[] = [];
  private readonly reportedFields = new Set<string>();
  private readonly reportedLines = new Set<string>();

  add(problem: ProfileProblem): void {
    this.reportedFields.add(`${problem.file}\0${problem.field ?? ""}`);
    if (problem.line) this.reportedLines.add(`${problem.file}\0${problem.line}`);
    if (this.list.length < PROFILE_MAX_PROBLEMS) this.list.push(problem);
  }

  warn(problem: ProfileProblem): void {
    if (this.warnings.length < PROFILE_MAX_PROBLEMS) this.warnings.push(problem);
  }

  hasLine(file: string, line: number): boolean {
    return this.reportedLines.has(`${file}\0${line}`);
  }

  has(file: string, field: string): boolean {
    for (const prefix of fieldPrefixes(field)) if (this.reportedFields.has(`${file}\0${prefix}`)) return true;
    return false;
  }

  fileHas(file: string): boolean {
    return this.list.some((problem) => problem.file === file);
  }
}

function fieldPrefixes(field: string): string[] {
  const prefixes: string[] = [];
  const parts = field.split(/(?=[.[])/);
  for (let i = 1; i <= parts.length; i++) prefixes.push(parts.slice(0, i).join(""));
  return prefixes;
}

/** A field's path as a problem names it: `tools.allow[2]`, `headers.Authorization`. */
export function fieldName(path: readonly PropertyKey[]): string {
  return path.map((part, index) => typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${String(part)}`).join("");
}

function nodeAt(doc: Document, path: readonly (string | number)[], key: boolean): Node | undefined {
  let node: unknown = doc.contents;
  let found: Node | undefined = node as Node | undefined;
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (isMap(node)) {
      const pair = node.items.find((item) => isPair(item) && isScalar(item.key) && item.key.value === part);
      if (!pair) return found;
      if (key && i === path.length - 1) return pair.key as Node;
      found = (pair.key as Node) ?? found;
      node = pair.value;
    } else if (isSeq(node) && typeof part === "number") {
      node = node.items[part];
    } else return found;
    if (node && typeof node === "object" && "range" in node) found = node as Node;
  }
  return found;
}

function frontMatterEnd(source: string): number | "missing" | "unclosed" {
  if (!source.startsWith("---\n")) return "missing";
  let end = source.indexOf("\n---", 3);
  while (end >= 0 && end + 4 < source.length && source[end + 4] !== "\n") end = source.indexOf("\n---", end + 1);
  return end < 0 ? "unclosed" : end;
}

export function bodyLineOf(source: string): number {
  const end = frontMatterEnd(source);
  if (end === "missing") return 1;
  if (end === "unclosed") return Number.MAX_SAFE_INTEGER;
  return source.slice(4, end + 1).split("\n").length + 2;
}

function splitFrontMatter(file: string, source: string, problems: Problems): { yaml: string; body: string; bodyLine: number } | null {
  const end = frontMatterEnd(source);
  if (end === "missing") {
    problems.add({ file, line: 1, message: "must start with a front matter block: a line with ---, the YAML fields, then another ---" });
    return null;
  }
  if (end === "unclosed") {
    problems.add({ file, line: 1, message: "has a front matter block that never closes: end it with a line holding only ---" });
    return null;
  }
  return { yaml: source.slice(4, end + 1), body: source.slice(Math.min(end + 5, source.length)), bodyLine: bodyLineOf(source) };
}

export function invisibleProblem(file: string, line: number | undefined, codePoint: number): ProfileProblem {
  const name = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  return { file, ...(line ? { line } : {}), message: `has an invisible or control character (${name}) on this line; delete it, since profile settings never need one` };
}

/** YAML escapes such as `"\u200B"` are plain ASCII in the file, so each decoded field name and text value is checked
 * again. */
function refuseDecodedInvisibles(file: string, data: unknown, lineOf: ParsedDoc["lineOf"], problems: Problems): boolean {
  let found = false;
  const check = (text: string, path: (string | number)[], key: boolean) => {
    const invisible = findInvisibles(text, Number.MAX_SAFE_INTEGER)[0];
    if (!invisible) return;
    found = true;
    const line = lineOf(path, key) ?? 2;
    if (!problems.hasLine(file, line)) problems.add(invisibleProblem(file, line, invisible.codePoint));
  };
  const walk = (value: unknown, path: (string | number)[]) => {
    if (typeof value === "string") return check(value, path, false);
    if (Array.isArray(value)) return value.forEach((entry, index) => walk(entry, [...path, index]));
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      check(key, [...path, key], true);
      walk(entry, [...path, key]);
    }
  };
  walk(data, []);
  return found;
}

export function parseFrontMatter(file: string, source: string, problems: Problems): (ParsedDoc & { bodyLine: number }) | null {
  const split = splitFrontMatter(file, source, problems);
  if (!split) return null;
  const counter = new LineCounter();
  const doc = parseDocument(split.yaml, { lineCounter: counter, prettyErrors: true, uniqueKeys: true });
  const lastLine = split.yaml.split("\n").length;
  const lineOfOffset = (offset: number) => Math.min(counter.linePos(offset).line + 1, lastLine);
  const yamlProblems = [...doc.errors, ...doc.warnings];
  if (yamlProblems.length) {
    for (const error of yamlProblems) {
      const line = error.linePos?.[0]?.line === undefined ? undefined : Math.min(error.linePos[0].line, lastLine - 1);
      const message = error.code === "DUPLICATE_KEY" ? "has the same field twice" : `is not valid YAML: ${error.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "")}`;
      problems.add({ file, ...(line ? { line: line + 1 } : {}), message });
    }
    return null;
  }
  let alias: number | undefined;
  visit(doc, { Alias(_key, node) { alias ??= node.range ? lineOfOffset(node.range[0]) : undefined; } });
  if (alias !== undefined || doc.contents && isAlias(doc.contents)) {
    problems.add({ file, ...(alias ? { line: alias } : {}), message: "uses a YAML alias (*name); write the value out in full" });
    return null;
  }
  const data = doc.toJS({ maxAliasCount: 0 }) as unknown;
  const lineOf: ParsedDoc["lineOf"] = (path, key = false) => {
    const node = nodeAt(doc, path, key);
    return node?.range ? lineOfOffset(node.range[0]) : undefined;
  };
  if (refuseDecodedInvisibles(file, data, lineOf, problems)) return null;
  if (data === null || data === undefined) {
    problems.add({ file, line: 2, message: "has an empty front matter: it needs at least edubot: 1 and kind:" });
    return null;
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    problems.add({ file, line: 2, message: "has a front matter that is not a list of fields (field: value, one per line)" });
    return null;
  }
  return {
    file,
    data: data as Record<string, unknown>,
    body: split.body,
    bodyLine: split.bodyLine,
    lineOf,
  };
}

export function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let value = data;
  for (const part of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<PropertyKey, unknown>)[part];
  }
  return value;
}
