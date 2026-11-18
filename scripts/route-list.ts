// Reads every HTTP route the server answers out of its own source, so the published route list (GET /api/openapi.json,
// server/routes/openapi.ts) is derived from the code that matches requests and cannot drift from it.
//
// There is no declarative route table: server/index.ts and the modules in server/routes match the request path inline
// (`path === "/api/x"`, `/^\/api\/bots\/([\w-]+)$/.exec(path)`, `path.startsWith(...)`). This walks the TypeScript AST of
// every server source file, finds each test of the request path inside a function that can answer the request (one that
// binds `res` or a RouteContext), and pairs it with the method test that guards it.
//
// It fails closed: a request-path test it cannot turn into a path and method is reported in `unresolved`, and
// scripts/testing/route-list.test.ts fails while that list is not empty. Nothing is dropped quietly.
//
//   node scripts/route-list.ts          rewrite server/routes/route-list.generated.ts
//   node scripts/route-list.ts --check  exit 1 when that file is not what the source says
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";

import { templatesOf } from "./route-patterns.ts";

export { nameParams, templatesOf } from "./route-patterns.ts";

export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type Method = (typeof METHODS)[number];

export interface ExtractedRoute {
  /** OpenAPI path template: `/api/bots/{botId}`. */
  path: string;
  /** Upper-case methods; ["*"] when the handler answers this path whatever the method. */
  methods: string[];
  /** "exact" (literal, template or anchored pattern) or "prefix" (`path.startsWith`): everything under the path. */
  match: "exact" | "prefix";
  /** The pattern as written, when the source matched with a regular expression. */
  pattern?: string;
  /** "websocket" when the path is claimed for upgrades; "sse" when its handler answers text/event-stream. */
  transport?: "websocket" | "sse";
  /** The files that match it, relative to the repo root. */
  sources: string[];
}

export interface Unresolved {
  source: string;
  text: string;
  why: string;
}

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** Import and re-export hops followed for one name: a guard against an import cycle, far deeper than any real chain (a
 * barrel re-exporting a package file is two). A name it gives up on is reported as unresolved, never dropped. */
const MAX_IMPORT_HOPS = 16;
export const OUTPUT = "server/routes/route-list.generated.ts";

/** Sources that ship, server/ and the shared/ and packages/ modules it imports constants from: no tests, no fixtures. */
export function sourceFiles(root = ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!["node_modules", "testing", "fixtures", "dist"].includes(entry.name)) walk(rel);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|e2e\.test|d)\.tsx?$/.test(entry.name) && !entry.name.endsWith(".generated.ts")) {
        out.push(rel);
      }
    }
  };
  walk("server");
  walk("shared");
  walk("packages");
  return out.sort();
}

type Fn = ts.FunctionLikeDeclaration;

const isFn = (node: ts.Node): node is Fn =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

const strip = (node: ts.Expression): ts.Expression => {
  let out = node;
  while (ts.isParenthesizedExpression(out) || ts.isAsExpression(out) || ts.isNonNullExpression(out) || ts.isSatisfiesExpression(out)) out = out.expression;
  return out;
};

/** Names a parameter list binds, destructuring included. */
function boundNames(name: ts.BindingName, into: Set<string>): Set<string> {
  if (ts.isIdentifier(name)) into.add(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) boundNames(element.name, into);
  return into;
}

function paramNames(fn: Fn): Set<string> {
  const names = new Set<string>();
  for (const param of fn.parameters) boundNames(param.name, names);
  return names;
}

/** A parameter typed RouteContext (`ctx: RouteContext`, or the function itself declared `: RouteHandler`): `ctx.path`
 * is the request path there. */
function contextParams(fn: Fn): Set<string> {
  const out = new Set<string>();
  const handler = ts.isVariableDeclaration(fn.parent) && !!fn.parent.type && /\bRouteHandler\b/.test(fn.parent.type.getText());
  for (const param of fn.parameters) {
    // An untyped single `ctx` parameter is the route handler's context (the factory's return type says so, not the arrow).
    // A single `ctx` parameter is a route handler's context however it is typed: `RouteContext`, a host's own
    // `PhoneGateContext`, or an inline `{ method; path; res; ... }`.
    const untypedCtx = fn.parameters.length === 1 && ts.isIdentifier(param.name) && (param.name.text === "ctx" || usedAsContext(fn, param.name.text));
    if (ts.isIdentifier(param.name) && ((param.type && /\bRouteContext\b/.test(param.type.getText())) || (handler && fn.parameters.indexOf(param) === 0) || untypedCtx)) out.add(param.name.text);
  }
  return out;
}

/** A lone parameter the body reads as a request context: `args.path` together with `args.res` (a `{ method, path }`
 * table row read in a `.some(...)` is not one). */
function usedAsContext(fn: Fn, name: string): boolean {
  if (!fn.body) return false;
  const read = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) read.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return read.has("path") && read.has("res");
}

/** `const { req, res, path, method } = ctx`: a request context taken apart in a function body. */
function contextDestructure(d: ts.VariableDeclaration): Set<string> | null {
  if (!ts.isObjectBindingPattern(d.name)) return null;
  const names = boundNames(d.name, new Set());
  return names.has("path") && (names.has("method") || names.has("res") || names.has("req")) ? names : null;
}

/** Names a function's own body binds by taking a request context apart. */
function bodyContextNames(fn: Fn): Set<string> {
  const out = new Set<string>();
  if (!fn.body || !ts.isBlock(fn.body)) return out;
  for (const st of fn.body.statements) if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) for (const n of contextDestructure(d) ?? []) out.add(n);
  return out;
}

export interface FileFacts {
  file: string;
  sf: ts.SourceFile;
  /** `const X = "..."` / `const X = /.../` at any level, by name (the last one wins; names here are unique in practice). */
  consts: Map<string, ts.Expression>;
  /** `import { X } from "./y.ts"`: local name to [resolved file, exported name]. */
  imports: Map<string, [string, string]>;
  /** `export * from "./y.ts"` targets. */
  stars: string[];
  /** Functions by name (declarations and `const f = (...) => ...`): a list one returns, a predicate one applies. */
  fns: Map<string, ts.FunctionLikeDeclaration>;
}

export function parse(file: string, text: string): FileFacts {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const consts = new Map<string, ts.Expression>();
  const imports = new Map<string, [string, string]>();
  const stars: string[] = [];
  const fns = new Map<string, ts.FunctionLikeDeclaration>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) fns.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) fns.set(node.name.text, node.initializer);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) {
      consts.set(node.name.text, node.initializer);
    }
    // `export { X } from "./y.ts"` and `export * from "./y.ts"`: a barrel's names resolve through to their file.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(".")) {
      const target = join(file, "..", node.moduleSpecifier.text).split(sep).join("/");
      if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const el of node.exportClause.elements) imports.set(el.name.text, [target, (el.propertyName ?? el.name).text]);
      else if (!node.exportClause) stars.push(target);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(".") && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const target = join(file, "..", node.moduleSpecifier.text).split(sep).join("/");
      for (const el of node.importClause.namedBindings.elements) imports.set(el.name.text, [target, (el.propertyName ?? el.name).text]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { file, sf, consts, imports, stars, fns };
}

/** Everything known about the server's source, so a constant imported from another file resolves. */
export class Corpus {
  readonly files = new Map<string, FileFacts>();
  constructor(sources: Map<string, string>) {
    for (const [file, text] of sources) this.files.set(file, parse(file, text));
  }

  /** A function declaration by name, followed through imports, with the file that declares it. */
  resolveFunction(facts: FileFacts, name: string, depth = 0): [FileFacts, ts.FunctionLikeDeclaration] | undefined {
    if (depth > MAX_IMPORT_HOPS) return undefined;
    const local = facts.fns.get(name);
    if (local) return [facts, local];
    const imported = facts.imports.get(name);
    const target = imported ? this.files.get(imported[0]) : undefined;
    if (target && imported) return this.resolveFunction(target, imported[1], depth + 1);
    for (const star of facts.stars) {
      const t = this.files.get(star);
      const found = t ? this.resolveFunction(t, name, depth + 1) : undefined;
      if (found) return found;
    }
    return undefined;
  }

  /** The value a constant name stands for, followed through imports; undefined when it is not a constant. */
  resolve(facts: FileFacts, name: string): ts.Expression | undefined {
    return this.resolveIn(facts, name)?.[1];
  }

  /** The value a constant stands for and the file that defines it (its own names resolve there). */
  resolveIn(facts: FileFacts, name: string, depth = 0): [FileFacts, ts.Expression] | undefined {
    if (depth > MAX_IMPORT_HOPS) return undefined;
    const local = facts.consts.get(name);
    if (local) {
      const value = strip(local);
      return ts.isIdentifier(value) ? this.resolveIn(facts, value.text, depth + 1) : [facts, value];
    }
    const imported = facts.imports.get(name);
    if (imported) {
      const target = this.files.get(imported[0]);
      return target ? this.resolveIn(target, imported[1], depth + 1) : undefined;
    }
    for (const star of facts.stars) {
      const target = this.files.get(star);
      const found = target ? this.resolveIn(target, name, depth + 1) : undefined;
      if (found) return found;
    }
    return undefined;
  }
}

// ---- finding the request-path tests --------------------------------------------------------------------------

/** `const path = url.pathname` (or `= new URL(...).pathname`): the request path, bound in a function body. */
function pathnameDeclarations(fn: Fn): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node) => {
    if (node !== fn && isFn(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = strip(node.initializer);
      if (ts.isPropertyAccessExpression(init) && init.name.text === "pathname") out.add(node.name.text);
      // `(req.url ?? "/").split("?")[0]`: the path cut from the request line by hand.
      else if (/\breq\.url\b/.test(init.getText()) && /split\(\s*"\?"\s*\)/.test(init.getText())) out.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return out;
}

/** The scope that binds `name` as seen from `node`, or null. */
function bindingOf(node: ts.Node, name: string): Fn | null {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (!isFn(at)) {
      // A block-level `const path = ...` that is not a pathname shadows the request path.
      if ((ts.isBlock(at) || ts.isSourceFile(at)) && at.statements.some((s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => boundNames(d.name, new Set()).has(name)))) {
        const fn = enclosingFn(at);
        if (fn && (pathnameDeclarations(fn).has(name) || (fn.body === at && bodyContextNames(fn).has(name)))) return fn;
        return null;
      }
      continue;
    }
    if (paramNames(at).has(name)) return at;
  }
  return null;
}

function enclosingFn(node: ts.Node): Fn | null {
  for (let at = node.parent; at; at = at.parent) if (isFn(at)) return at;
  return null;
}

/** Is `expr` the request path here? */
function isRequestPath(expr: ts.Expression): boolean {
  const e = strip(expr);
  if (ts.isIdentifier(e)) {
    // The function that binds the name must be the one that answers: an inner `async (path) => save(path)` binds a
    // file's path of its own, whatever handler it sits in.
    const fn = bindingOf(e, e.text);
    return fn !== null && answersHere(fn) && (e.text === "path" || e.text === "pathname");
  }
  if (ts.isPropertyAccessExpression(e) && e.name.text === "path" && ts.isIdentifier(e.expression)) {
    const fn = bindingOf(e.expression, e.expression.text);
    return fn !== null && contextParams(fn).has(e.expression.text);
  }
  return false;
}

interface Site {
  node: ts.Expression;
  kind: "exact" | "template" | "pattern" | "prefix" | "list";
  /** Paths before method pairing. */
  paths: string[];
  pattern?: string;
  /** Those of `paths` that stand for everything below them. */
  prefixes?: string[];
}

const methodLiteral = (e: ts.Expression): string | null => {
  const s = strip(e);
  return ts.isStringLiteral(s) || ts.isNoSubstitutionTemplateLiteral(s) ? s.text.toUpperCase() : null;
};

/** The methods a method-valued expression can be: a literal, or `cond ? "GET" : "POST"`. */
function methodLiterals(e: ts.Expression): Set<string> | null {
  const s = strip(e);
  if (ts.isConditionalExpression(s)) {
    const a = methodLiterals(s.whenTrue);
    const b = methodLiterals(s.whenFalse);
    return a && b ? new Set([...a, ...b]) : null;
  }
  const lit = methodLiteral(s);
  return lit ? new Set([lit]) : null;
}

const isMethodRef = (e: ts.Expression): boolean => {
  const s = strip(e);
  if (ts.isIdentifier(s)) return s.text === "method" || s.text === "upper" || s.text === "verb";
  // `req.method`, `ctx.method`, `args.method`: the method of whatever request context is in hand.
  if (ts.isPropertyAccessExpression(s)) return s.name.text === "method" && ts.isIdentifier(s.expression);
  if (ts.isCallExpression(s) && ts.isPropertyAccessExpression(s.expression) && s.expression.name.text === "toUpperCase") return isMethodRef(s.expression.expression);
  return false;
};

/** Method constraint an expression states when true: a set of methods, or null when it says nothing about the method. */
function methodsWhenTrue(expr: ts.Expression): Set<string> | null {
  const e = strip(expr);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
      if (isMethodRef(e.left) && methodLiterals(e.right)) return methodLiterals(e.right);
      if (isMethodRef(e.right) && methodLiterals(e.left)) return methodLiterals(e.left);
    }
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
      const lits = isMethodRef(e.left) ? methodLiterals(e.right) : isMethodRef(e.right) ? methodLiterals(e.left) : null;
      if (lits) return new Set(METHODS.filter((m) => !lits.has(m)));
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const l = methodsWhenTrue(e.left);
      const r = methodsWhenTrue(e.right);
      if (l && r) return new Set([...l].filter((m) => r.has(m)));
      return l ?? r;
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const l = methodsWhenTrue(e.left);
      const r = methodsWhenTrue(e.right);
      if (l && r) return new Set([...l, ...r]);
      return null;
    }
  }
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return methodsWhenFalse(e.operand);
  // ["GET", "HEAD"].includes(method)
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "includes" && e.arguments.length === 1 && isMethodRef(e.arguments[0])) {
    const list = strip(e.expression.expression);
    if (ts.isArrayLiteralExpression(list)) {
      const lits = list.elements.map((x) => methodLiteral(x as ts.Expression));
      if (lits.every(Boolean)) return new Set(lits as string[]);
    }
  }
  return null;
}

/**
 * Method constraint an expression states when false. `!(method === "GET" && path === P)` says nothing about the method
 * (the path may be what differs), so a conjunction constrains only when every operand is about the method.
 */
function methodsWhenFalse(expr: ts.Expression): Set<string> | null {
  const e = strip(expr);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const l = methodsWhenFalse(e.left);
    const r = methodsWhenFalse(e.right);
    return l && r ? new Set([...l, ...r]) : null;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) return intersect(methodsWhenFalse(e.left), methodsWhenFalse(e.right));
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return methodsWhenTrue(e.operand);
  const t = methodsWhenTrue(e);
  return t ? new Set(METHODS.filter((m) => !t.has(m))) : null;
}

const intersect = (a: Set<string> | null, b: Set<string> | null): Set<string> | null => (a && b ? new Set([...a].filter((m) => b.has(m))) : a ?? b);

const exits = (s: ts.Statement): boolean => {
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isContinueStatement(s) || ts.isBreakStatement(s)) return true;
  if (ts.isBlock(s)) return s.statements.length > 0 && exits(s.statements[s.statements.length - 1]);
  if (ts.isIfStatement(s)) return exits(s.thenStatement) && !!s.elseStatement && exits(s.elseStatement);
  return false;
};

/**
 * The methods under which control reaches `node`, read from the code around it: `&&` operands beside it, the conditions
 * of every `if` and `?:` it sits in, `switch (method)` cases, and earlier `if (...) return` guards in each enclosing block.
 * null when nothing around it tests the method.
 */
function methodsReaching(node: ts.Node): Set<string> | null {
  let out: Set<string> | null = null;
  let child: ts.Node = node;
  for (let at = node.parent; at; child = at, at = at.parent) {
    if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const other = at.left === child ? at.right : at.left;
      out = intersect(out, methodsWhenTrue(other));
    } else if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.BarBarToken && at.right === child) {
      out = intersect(out, methodsWhenFalse(at.left));
    } else if (ts.isIfStatement(at) && at.expression !== child) {
      out = intersect(out, at.thenStatement === child ? methodsWhenTrue(at.expression) : methodsWhenFalse(at.expression));
    } else if (ts.isConditionalExpression(at) && at.condition !== child) {
      out = intersect(out, at.whenTrue === child ? methodsWhenTrue(at.condition) : methodsWhenFalse(at.condition));
    } else if (ts.isCaseClause(at) && ts.isSwitchStatement(at.parent.parent) && isMethodRef(at.parent.parent.expression)) {
      const lit = methodLiteral(at.expression);
      if (lit) out = intersect(out, new Set([lit]));
    }
    if ((ts.isBlock(at) || ts.isSourceFile(at) || ts.isCaseClause(at)) && "statements" in at) {
      for (const s of at.statements) {
        if (s === child) break;
        if (ts.isIfStatement(s) && !s.elseStatement && exits(s.thenStatement)) out = intersect(out, methodsWhenFalse(s.expression));
      }
    }
    if (isFn(at) && answersHere(at)) break;
  }
  return out;
}

/** The function that is the request's own handler: walking stops there. */
const answersHere = (fn: Fn): boolean => paramNames(fn).has("res") || contextParams(fn).size > 0 || bodyContextNames(fn).has("res");

/** What a request-path test guards, read from where it sits. */
export interface Region {
  /** The statements (or expression) that run when the test passes. */
  nodes: ts.Node[];
  /** The test is negated (`path !== P`, `!re.test(path)`) and sits in `if (...) <refuse>`: the rest of the block is P's. */
  gate: boolean;
  /** A negated test that does not guard anything (an exclusion such as `path !== "/api/events"`): not a route. */
  exclusion: boolean;
  /** For a gate, the methods its own condition lets through (`path !== P || method !== "PUT"` lets PUT through). */
  through?: Set<string> | null;
}

const climbable = (n: ts.Node, child: ts.Node): boolean =>
  isLogical(n) || ts.isParenthesizedExpression(n) || (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) ||
  // The test's value flows on: `cond ? re.exec(path) : null`, `re.exec(path)?.[1]`, `a ?? re.exec(path)`.
  ts.isConditionalExpression(n) ||
  ((ts.isElementAccessExpression(n) || ts.isPropertyAccessExpression(n) || ts.isNonNullExpression(n)) && n.expression === child) ||
  (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) ||
  // `if (method === "GET" && (m = re.exec(path)))`: an assignment used as a value is the test itself.
  (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.right === child && !!n.parent && (ts.isParenthesizedExpression(n.parent) || isLogical(n.parent)));

/** Is the test at `site` negated on its way up to the statement that holds it? */
function negated(site: ts.Node, top: ts.Node): boolean {
  let odd = ts.isBinaryExpression(site) && [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(site.operatorToken.kind);
  for (let at = site.parent; at && at !== top.parent; at = at.parent) if (ts.isPrefixUnaryExpression(at) && at.operator === ts.SyntaxKind.ExclamationToken) odd = !odd;
  return odd;
}

/** The statements after `statement` in its block, up to (not including) one that reassigns `name`. */
function after(statement: ts.Node, name?: string): ts.Statement[] {
  const block = statement.parent;
  if (!block || !("statements" in block)) return [];
  const list = (block as ts.Block).statements;
  const out: ts.Statement[] = [];
  for (const s of list.slice(list.indexOf(statement as ts.Statement) + 1)) {
    if (name && assigns(s, name)) break;
    out.push(s);
  }
  return out;
}

export function regionOf(site: ts.Node): Region {
  let top: ts.Node = site;
  while (top.parent && climbable(top.parent, top)) top = top.parent;
  const holder = top.parent;
  const neg = negated(site, top);
  if (holder && ts.isIfStatement(holder) && holder.expression === top) {
    if (!neg) return { nodes: [holder.thenStatement], gate: false, exclusion: false };
    if (!holder.elseStatement && (exits(holder.thenStatement) || refuses(holder.thenStatement))) return { nodes: after(holder), gate: true, exclusion: false, through: methodsWhenFalse(holder.expression) };
    return { nodes: [], gate: false, exclusion: true };
  }
  if (neg) return { nodes: [], gate: false, exclusion: true };
  // `const m = re.exec(path)` / `m = path.match(re)` / `const x = path === P ? a : null`: what later reads that name, up to
  // its next assignment; after `if (!m) return ...` the rest of the block is the route's.
  const declared = holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder : null;
  const assigned = holder && ts.isBinaryExpression(holder) && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(holder.left) && holder.right === top ? holder : null;
  const name = declared ? (declared.name as ts.Identifier).text : assigned ? (assigned.left as ts.Identifier).text : null;
  const statement = declared ? declared.parent.parent : assigned?.parent;
  if (name && statement) {
    const nodes: ts.Node[] = [];
    let all = false;
    // Values taken from the match (`const id = (a ?? m)?.[1]`, `const file = read(m[2])`) carry it on.
    const names = new Set([name]);
    for (const s of after(statement, name)) {
      const reads = [...names].some((n) => mentions(s, n));
      if (all || reads) nodes.push(s);
      if (reads && ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) boundNames(d.name, names);
      if (!all && ts.isIfStatement(s) && !s.elseStatement && (exits(s.thenStatement) || refuses(s.thenStatement)) && leavesWithout(s.expression, name)) all = true;
    }
    return { nodes, gate: false, exclusion: false };
  }
  // An operand of `&&` in an expression statement, a return, or an argument: the expression itself is what it guards.
  return { nodes: [top.parent ?? top], gate: false, exclusion: false };
}

/** Does any of these nodes answer the request (a return, or a call handed `res`/`json`)? */
function answersIn(nodes: ts.Node[]): boolean {
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) hit = true;
    else if (ts.isCallExpression(n) && (n.arguments.some((a) => ts.isIdentifier(strip(a)) && ["res", "ctx"].includes((strip(a) as ts.Identifier).text)) || /^(json|send|reply|respond)\b/.test(n.expression.getText()))) hit = true;
    else ts.forEachChild(n, visit);
  };
  for (const n of nodes) visit(n);
  return hit;
}

/**
 * When nothing around a path test names the method, the handler may branch on it inside: `if (path === P) { if (method
 * === "GET") ...; if (method === "PUT") ... }`, `if (method !== "POST") return json(res, 405, ...)`, or `switch (method)`.
 * These are the methods the guarded code answers, or null when it never tests the method.
 */
function methodsInside(nodes: ts.Node[]): Set<string> | null {
  let found: Set<string> | null = null;
  const add = (m: Set<string> | null) => { if (m) found = new Set([...(found ?? []), ...m]); };
  const visit = (node: ts.Node) => {
    if (isFn(node)) return;
    if (ts.isIfStatement(node)) {
      // A refusal (`return PASS`, a 405) names the methods it turns away, not the ones it answers.
      // Elsewhere only a positive test names what is answered: `if (... && method !== "DELETE") { ... }` says what is not.
      add(refuses(node.thenStatement) ? methodsWhenFalse(node.expression) : positive(node.expression) ? methodsWhenTrue(node.expression) : null);
    } else if (ts.isConditionalExpression(node)) {
      add(methodsWhenTrue(node.condition));
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && (ts.isExpressionStatement(node.parent) || ts.isReturnStatement(node.parent))) {
      // `method === "POST" && answer(res)` as a statement of its own.
      add(methodsWhenTrue(node.left));
    }
    if (ts.isSwitchStatement(node) && isMethodRef(node.expression)) {
      for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause)) add(methodLiterals(clause.expression));
    }
    ts.forEachChild(node, visit);
  };
  for (const n of nodes) visit(n);
  return found;
}

/** Does the condition test the method only with `===` / `includes` (no `!==`, no negation)? */
function positive(cond: ts.Expression): boolean {
  let ok = true;
  const visit = (n: ts.Node) => {
    if (!ok || isFn(n)) return;
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind) && (isMethodRef(n.left) || isMethodRef(n.right))) ok = false;
    else if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken && methodsWhenTrue(n.operand)) ok = false;
    else ts.forEachChild(n, visit);
  };
  visit(cond);
  return ok;
}

/** `return PASS`, `return false`, or an answer of 405: the code turns this request away. */
function refuses(s: ts.Statement): boolean {
  if (declines(s)) return true;
  return /\(\s*([\w.]*\bres\s*,\s*)?405\b/.test(s.getText());
}

/** One statement that only answers 403 or 405: a policy refusal in front of routes (`if (hosted && method !== "GET")
 * return json(res, 403, ...)`), not a route of its own. */
function policyRefusal(nodes: ts.Node[]): boolean {
  if (nodes.length !== 1 || !ts.isStatement(nodes[0] as ts.Node)) return false;
  const only = nodes[0] as ts.Statement;
  const body = ts.isIfStatement(only) && !only.elseStatement ? only.thenStatement : only;
  const last = ts.isBlock(body) ? (body.statements.length === 1 ? body.statements[0] : null) : body;
  return !!last && ts.isReturnStatement(last) && /^(void\s+)?[\w.]+\(\s*([\w.]*\bres\s*,\s*)?40[35]\b/.test(last.expression?.getText() ?? "");
}

const isLogical = (n: ts.Node): boolean =>
  ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken);

/** `return PASS` (or `return void ...PASS`): the handler hands the request on. */
function declines(s: ts.Statement): boolean {
  const last = ts.isBlock(s) ? s.statements[s.statements.length - 1] : s;
  if (!last || !ts.isReturnStatement(last) || !last.expression) return false;
  const text = last.expression.getText();
  return (text === "false" || /\bPASS\b/.test(text)) && !/json\(|writeHead|end\(/.test(text);
}

/** Does this statement assign `name` again: `m = ...;`, or `if (... (m = re.exec(path)))`? */
function assigns(s: ts.Statement, name: string): boolean {
  const head = ts.isExpressionStatement(s) ? s.expression : ts.isIfStatement(s) ? s.expression : null;
  if (!head) return false;
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit || isFn(n)) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === name) hit = true;
    else ts.forEachChild(n, visit);
  };
  visit(head);
  return hit;
}

/** `!m`, `!m || ...`: the condition is true whenever `m` is empty, so code after `if (cond) return` runs only with `m`. */
function leavesWithout(cond: ts.Expression, name: string): boolean {
  const e = strip(cond);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = strip(e.operand);
    return (ts.isIdentifier(inner) && inner.text === name) || (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner) ? mentions(inner, name) : false);
  }
  // `!m || ...` leaves whenever m is empty; `!a && !m` leaves when every one is empty, so what follows runs with m or
  // with a: the rest of the block is m's (and a's) either way.
  if (isLogical(e)) return leavesWithout((e as ts.BinaryExpression).left, name) || leavesWithout((e as ts.BinaryExpression).right, name);
  return false;
}

function mentions(node: ts.Node, name: string): boolean {
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isIdentifier(n) && n.text === name) hit = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/**
 * Functions handed the request path that decide nothing about which routes exist: they classify a request already bound
 * for a route defined elsewhere (its scope, audit line, visibility, idle accounting, a move freeze). Each is named here so
 * that a new hand-off is read or reported, never skipped unseen.
 */
const POLICY: ReadonlySet<string> = new Set([
  "adminAuditPlan", "adminAuditRows", // which admin requests the audit log records (admin-audit-plan.ts)
  "botAccess.accessRefusal", "hiddenThreadRefusal", "pathSubject", // who may see the bot or thread a path names (bot-visibility.ts)
  "botApiRouteRefused", "outsideRouteRefused", "proactive.fence.refusesRoute", "externalRuntimeMayCall", // what a turn's caller may reach
  "checks", "checked", // what a Team Cloud move-in session may send (team-move-in.ts)
  "countsAsActivity", "begin", "cloudPower.arrived", // what keeps a Cloud home awake (cloud-power.ts)
  "backgroundWhileAsleep", // a sleeping Cloud home answering a background poll (routes/threads.ts)
  "freeze.refuses", "moveFreeze.screen", // a bot mid-move refuses changes; its page redirects (move-freeze.ts)
  "isBotLinkHeldPath", "isLongPollPath", "isWorkspaceBackupSessionControl", // requests the idle and maintenance counters leave out
]);

const isStringMethod = (callee: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(callee) && ["exec", "test", "match", "startsWith", "endsWith", "includes", "has", "split", "slice", "replace", "indexOf", "toLowerCase", "trim"].includes(callee.name.text);

const passesResponse = (a: ts.Expression): boolean => {
  const e = strip(a);
  return (ts.isIdentifier(e) && (e.text === "res" || e.text === "ctx")) || (ts.isPropertyAccessExpression(e) && e.name.text === "res");
};

/** The paths a predicate `(path) => ...` accepts: its positive tests on that parameter, read in its own file. null when
 * it is not a function the reader can open. */
function testsOn(corpus: Corpus, facts: FileFacts, fn: ts.FunctionLikeDeclaration, param: string): { paths: string[]; prefixes: string[]; pattern?: string } | null {
  if (!fn.body) return null;
  const paths: string[] = [];
  const prefixes: string[] = [];
  let pattern: string | undefined;
  const isParam = (e: ts.Expression) => ts.isIdentifier(strip(e)) && (strip(e) as ts.Identifier).text === param;
  const addRe = (re: RegExp) => { const t = templatesOf(re.source); paths.push(...t.paths, ...t.prefixes); prefixes.push(...t.prefixes); pattern ??= re.source; };
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(n.operatorToken.kind)) {
      const other = isParam(n.left) ? n.right : isParam(n.right) ? n.left : null;
      const lit = other ? literalAt(corpus, facts, other) : null;
      if (typeof lit === "string") paths.push(lit);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const name = n.expression.name.text;
      const arg = n.arguments[0];
      if (name === "startsWith" && isParam(n.expression.expression) && arg) {
        const lit = literalAt(corpus, facts, arg);
        if (typeof lit === "string") { paths.push(lit); prefixes.push(lit); }
      } else if ((name === "exec" || name === "test") && arg && isParam(arg)) {
        const re = literalAt(corpus, facts, n.expression.expression);
        if (re instanceof RegExp) addRe(re);
      } else if (name === "match" && isParam(n.expression.expression) && arg) {
        const re = literalAt(corpus, facts, arg);
        if (re instanceof RegExp) addRe(re);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return { paths: [...new Set(paths)], prefixes: [...new Set(prefixes)], ...(pattern ? { pattern } : {}) };
}

/** The string or pattern an expression stands for, read in `facts`'s scope: a literal, a constant (in the file that
 * defines it), a template of constants, or String.raw`...`; null when it is computed. */
function literalAt(corpus: Corpus, facts: FileFacts, e: ts.Expression): string | RegExp | null {
  const s = strip(e);
  if (ts.isStringLiteral(s) || ts.isNoSubstitutionTemplateLiteral(s)) return s.text;
  if (ts.isRegularExpressionLiteral(s)) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(s.text)!;
    return new RegExp(m[1], m[2]);
  }
  if (ts.isIdentifier(s)) {
    const found = corpus.resolveIn(facts, s.text);
    return found ? literalAt(corpus, found[0], found[1]) : null;
  }
  // String.raw`([\w-]{1,200})`: a pattern piece kept as written.
  if (ts.isTaggedTemplateExpression(s) && s.tag.getText() === "String.raw" && ts.isNoSubstitutionTemplateLiteral(s.template)) return s.template.rawText ?? s.template.text;
  if (ts.isTemplateExpression(s)) {
    let text = s.head.text;
    for (const span of s.templateSpans) {
      const part = literalAt(corpus, facts, span.expression);
      if (typeof part !== "string") return null;
      text += part + span.literal.text;
    }
    return text;
  }
  return null;
}

/**
 * `new RegExp(`^${pattern}$`)` inside `const name = (pattern) => ...`: the helper's name and the pattern text around its
 * parameter, so each call can be read as one anchored pattern.
 */
function matcherHelper(expr: ts.Expression): { name: string; head: string; tail: string } | null {
  const e = strip(expr);
  if (!ts.isNewExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== "RegExp" || !e.arguments?.[0]) return null;
  const tpl = strip(e.arguments[0]);
  if (!ts.isTemplateExpression(tpl) || tpl.templateSpans.length !== 1 || !ts.isIdentifier(tpl.templateSpans[0].expression)) return null;
  const param = tpl.templateSpans[0].expression.text;
  const fn = enclosingFn(e);
  if (!fn || !paramNames(fn).has(param) || !ts.isVariableDeclaration(fn.parent) || !ts.isIdentifier(fn.parent.name)) return null;
  return { name: fn.parent.name.text, head: tpl.head.text, tail: tpl.templateSpans[0].literal.text };
}

export interface Extraction {
  routes: ExtractedRoute[];
  unresolved: Unresolved[];
  /** Paths claimed for WebSocket upgrades (upgrades.route), as templates. */
  websocket: string[];
}

/** Every request-path test in the corpus. */
export function extract(corpus: Corpus): Extraction {
  const byKey = new Map<string, ExtractedRoute>();
  const unresolved: Unresolved[] = [];
  const websocket = new Set<string>();
  const where = (facts: FileFacts, node: ts.Node) => `${facts.file}:${facts.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  for (const facts of corpus.files.values()) {
    const sites: Site[] = [];
    const fail = (node: ts.Node, why: string) => unresolved.push({ source: where(facts, node), text: node.getText().replace(/\s+/g, " "), why });

    const literalOf = (e: ts.Expression): string | RegExp | null => literalAt(corpus, facts, e);

    const templateOf = (e: ts.Expression): string | null => {
      const s = strip(e);
      if (!ts.isTemplateExpression(s)) return null;
      let text = s.head.text;
      for (const span of s.templateSpans) {
        const ex = strip(span.expression);
        const name = ts.isIdentifier(ex) ? ex.text : ts.isPropertyAccessExpression(ex) ? `${ex.expression.getText().split(".").pop()}${ex.name.text[0].toUpperCase()}${ex.name.text.slice(1)}` : null;
        if (!name) return null;
        const resolved = ts.isIdentifier(ex) ? corpus.resolve(facts, ex.text) : undefined;
        text += (resolved && (ts.isStringLiteral(strip(resolved)) || ts.isNoSubstitutionTemplateLiteral(strip(resolved))) ? (strip(resolved) as ts.StringLiteral).text : `{${name}}`) + span.literal.text;
      }
      return text;
    };

    /** `f(...)` where f is a function whose every return is an array literal (or a `?:` of them): all their strings. */
    const returnedList = (call: ts.Expression): (string | RegExp | null)[] | null => {
      if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
      const found = corpus.resolveFunction(facts, call.expression.text);
      if (!found?.[1].body || !ts.isBlock(found[1].body)) return null;
      const out: (string | RegExp | null)[] = [];
      let ok = true;
      const take = (e: ts.Expression) => {
        const x = strip(e);
        if (ts.isConditionalExpression(x)) { take(x.whenTrue); take(x.whenFalse); }
        else if (ts.isArrayLiteralExpression(x)) for (const el of x.elements) out.push(ts.isSpreadElement(el) ? null : literalIn(found[0], el));
        else ok = false;
      };
      const visitReturns = (n: ts.Node) => { if (isFn(n)) return; if (ts.isReturnStatement(n) && n.expression) take(n.expression); ts.forEachChild(n, visitReturns); };
      (found[1].body as ts.Block).statements.forEach(visitReturns);
      return ok && out.length > 0 ? out : null;
    };

    /** A constant or literal read in another file's scope (a returned list's own imports). */
    const literalIn = (other: FileFacts, e: ts.Expression): string | null => {
      const x = strip(e);
      if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
      if (ts.isIdentifier(x)) { const v = corpus.resolve(other, x.text); return v ? literalIn(other, v) : null; }
      return null;
    };

    const addPattern = (node: ts.Expression, re: RegExp) => {
      try {
        const t = templatesOf(re.source);
        sites.push({ node, kind: t.paths.length === 0 ? "prefix" : "pattern", paths: [...t.paths, ...t.prefixes], pattern: re.source, prefixes: t.prefixes });
      } catch (error) {
        fail(node, `pattern ${re.source}: ${(error as Error).message}`);
      }
    };

    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
        const [p, other] = isRequestPath(node.left) ? [node.left, node.right] : isRequestPath(node.right) ? [node.right, node.left] : [null, null];
        if (p && other) {
          const lit = literalOf(other);
          const tpl = templateOf(other);
          if (typeof lit === "string") sites.push({ node, kind: "exact", paths: [lit] });
          else if (tpl) sites.push({ node, kind: "template", paths: [tpl] });
          else fail(node, "compared with something that is not a literal");
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression;
        const method = callee.name.text;
        const arg = node.arguments[0];
        if ((method === "exec" || method === "test") && arg && isRequestPath(arg)) {
          const re = literalOf(callee.expression);
          const helper = re instanceof RegExp ? null : matcherHelper(callee.expression);
          if (re instanceof RegExp) addPattern(node, re);
          else if (helper) {
            // `const match = (pattern: string) => new RegExp(`^${pattern}$`).exec(path)`: each call names one route.
            const calls: ts.CallExpression[] = [];
            const find = (n: ts.Node) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === helper.name) calls.push(n); ts.forEachChild(n, find); };
            find(facts.sf);
            if (calls.length === 0) fail(node, `matcher ${helper.name} is never called`);
            for (const call of calls) {
              const value = call.arguments[0] ? literalOf(call.arguments[0]) : null;
              if (typeof value !== "string") { fail(call, `${helper.name} called with something that is not a literal`); continue; }
              addPattern(call, new RegExp(`${helper.head}${value}${helper.tail}`));
            }
          } else fail(node, "pattern is not a literal");
        } else if ((method === "match" || method === "startsWith") && isRequestPath(callee.expression)) {
          const lit = arg ? literalOf(arg) : null;
          if (method === "match" && lit instanceof RegExp) addPattern(node, lit);
          else if (method === "startsWith" && typeof lit === "string") sites.push({ node, kind: "prefix", paths: [lit], prefixes: [lit] });
          else fail(node, `${method} with something that is not a literal`);
        } else if ((method === "includes" || method === "has") && arg && isRequestPath(arg)) {
          const list = literalOf(callee.expression) ?? (() => {
            const s = strip(callee.expression);
            if (ts.isIdentifier(s)) { const v = corpus.resolve(facts, s.text); return v ? strip(v) : null; }
            return s;
          })();
          const arr = list && typeof list === "object" && !(list instanceof RegExp) && ts.isNewExpression(list as ts.Node) ? (list as ts.NewExpression).arguments?.[0] : list;
          const elements = arr && typeof arr === "object" && !(arr instanceof RegExp) && ts.isArrayLiteralExpression(strip(arr as ts.Expression)) ? (strip(arr as ts.Expression) as ts.ArrayLiteralExpression).elements : null;
          const lits = elements?.map((x) => literalOf(x as ts.Expression)) ?? returnedList(strip(callee.expression));
          if (lits && lits.every((l) => typeof l === "string")) sites.push({ node, kind: "list", paths: lits as string[] });
          else if (ts.isCallExpression(strip(callee.expression))) fail(node, `${method} on a computed list`);
          else fail(node, `${method} on something that is not a literal list`);
        }
      }
      // The request path handed to another function. A hand-off that passes `res` too goes to a handler, read where it is
      // defined. A predicate the reader can resolve (`isLentMcpPath(path)`) is read here, its tests standing at the call.
      // POLICY names the predicates that classify requests for routes defined elsewhere. Anything else fails closed.
      if (ts.isCallExpression(node) && !isStringMethod(node.expression)) {
        const at = node.arguments.findIndex((a) => isRequestPath(a));
        const callee = node.expression.getText().replace(/\?\./g, ".");
        if (at >= 0 && !node.arguments.some(passesResponse) && !POLICY.has(callee)) {
          const found = ts.isIdentifier(node.expression) ? corpus.resolveFunction(facts, node.expression.text) : undefined;
          const param = found?.[1].parameters[at]?.name;
          const tests = found && param && ts.isIdentifier(param) ? testsOn(corpus, found[0], found[1], param.text) : null;
          if (!tests) fail(node, `hands the request path to ${callee}, which the reader cannot follow`);
          else if (tests.paths.length === 0) fail(node, `hands the request path to ${callee}, which tests nothing the reader can read`);
          else sites.push({ node, kind: tests.prefixes.length === tests.paths.length ? "prefix" : "pattern", ...tests });
        }
      }
      // upgrades.route((path) => ...): the paths WebSocket upgrades may take.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "route" && /\bupgrades$/i.test(node.expression.expression.getText()) && node.arguments[0] && isFn(node.arguments[0])) {
        const owner = node.arguments[0] as Fn;
        const scan = (n: ts.Node) => {
          // The owner tests the path the way a handler does: a pattern (literal or a named constant) or a literal path.
          const value = ts.isRegularExpressionLiteral(n) || ts.isIdentifier(n) ? literalOf(n as ts.Expression) : null;
          if (value instanceof RegExp) {
            try { const t = templatesOf(value.source); for (const p of [...t.paths, ...t.prefixes]) websocket.add(p); } catch (error) { fail(n, `upgrade pattern ${value.source}: ${(error as Error).message}`); }
          } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.startsWith("/")) websocket.add(n.text);
          else if (ts.isTemplateExpression(n)) { const t = templateOf(n); if (t) websocket.add(t); }
          ts.forEachChild(n, scan);
        };
        scan(owner.body!);
      }
      ts.forEachChild(node, visit);
    };
    visit(facts.sf);

    // Pass one: what each test guards, and whether it is a route on its own merits. Pass two drops the gates: a prefix
    // or early-return test is a gate only in front of a test that is itself a route.
    const judged = sites.map((site) => {
      const region = regionOf(site.node);
      // `path !== "/api/events"` in a condition that answers nothing on its own: an exception to some other rule.
      // `if (path === P || path.startsWith(P + "/")) return json(res, 405, ...)`: the catch-all refusal after P's real
      // methods; it adds no method, and the sites that answer P list it. A one-statement 403/405 is policy, not a route.
      // A test whose code never answers the request (it counts or labels it) is not a route either.
      const refusalOnly = !region.gate && region.nodes.length === 1 && ts.isStatement(region.nodes[0] as ts.Node) && refuses(region.nodes[0] as ts.Statement) && !methodsInside(region.nodes);
      const routeable = !region.exclusion && !refusalOnly && !(!region.gate && policyRefusal(region.nodes)) && (region.gate || answersIn(region.nodes));
      return { site, region, routeable };
    });
    for (const { site, region, routeable } of judged) {
      if (!routeable) continue;
      const behind = judged.filter((o) => o.site !== site && o.routeable && region.nodes.some((n) => o.site.node.pos >= n.pos && o.site.node.end <= n.end)).map((o) => o.site);
      const prefixes = site.prefixes ?? [];
      if (prefixes.length > 0 && prefixes.length === site.paths.length && behind.some((other) => other.paths.some((p) => prefixes.some((q) => p.startsWith(q) && p !== q)))) continue;
      if (region.gate && prefixes.length === 0 && behind.some((other) => other.paths.some((p) => site.paths.includes(p)))) continue;
      const methods = (region.gate ? intersect(region.through ?? null, methodsReaching(site.node)) : methodsReaching(site.node)) ?? methodsInside(region.nodes);
      if (methods !== null && methods.size === 0) { fail(site.node, "the method tests around it exclude every method"); continue; }
      const sse = region.nodes.some((n) => n.getText().includes("text/event-stream"));
      for (const path of site.paths) {
        if (!path.startsWith("/")) { fail(site.node, `${JSON.stringify(path)} is not a path`); continue; }
        const match = site.prefixes?.includes(path) ? "prefix" : "exact";
        const key = `${match} ${path}`;
        const route = byKey.get(key) ?? { path, methods: [], match, sources: [] } as ExtractedRoute;
        if (site.pattern && !route.pattern) route.pattern = site.pattern;
        if (sse) route.transport = "sse";
        // A site that names no method (a `?:` that labels the path, say) does not widen a route other sites pin down.
        route.methods = [...new Set([...route.methods, ...(methods ?? ["*"])])];
        if (route.methods.length > 1) route.methods = route.methods.filter((m) => m !== "*");
        // The file, not the line: a line number would go stale with every unrelated edit above it.
        if (!route.sources.includes(facts.file)) route.sources.push(facts.file);
        byKey.set(key, route);
      }
    }
  }
  for (const route of byKey.values()) {
    route.methods.sort((a, b) => METHODS.indexOf(a as Method) - METHODS.indexOf(b as Method));
    route.sources.sort();
    if (websocket.has(route.path) || [...websocket].some((w) => route.match === "prefix" ? w.startsWith(route.path) : w === route.path)) route.transport = "websocket";
  }
  // `/api/bots/${bot}` and /^\/api\/bots\/([\w-]+)$/ are one path: OpenAPI forbids two templates that differ only in
  // their parameter names, so they merge under the first name found.
  const merged = new Map<string, ExtractedRoute>();
  for (const route of [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const key = `${route.match} ${route.path.replace(/\{[^}]+\}/g, "{}")}`;
    const into = merged.get(key);
    if (!into) { merged.set(key, route); continue; }
    into.methods = [...new Set([...into.methods, ...route.methods])].filter((m, _, all) => m !== "*" || all.length === 1);
    into.sources = [...new Set([...into.sources, ...route.sources])].sort();
    into.pattern ??= route.pattern;
    into.transport ??= route.transport;
  }
  for (const route of merged.values()) route.methods.sort((a, b) => METHODS.indexOf(a as Method) - METHODS.indexOf(b as Method));
  const routes = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path) || a.match.localeCompare(b.match));
  return { routes, unresolved, websocket: [...websocket].sort() };
}

export function loadCorpus(root = ROOT): Corpus {
  return new Corpus(new Map(sourceFiles(root).map((file) => [file, readFileSync(join(root, file), "utf8")])));
}

/** The generated module's text. */
export function render(routes: ExtractedRoute[]): string {
  const lines = routes.map((r) => `  ${JSON.stringify(r)},`);
  return [
    "// Generated by scripts/route-list.ts from the server's own route matching; do not edit.",
    "// `node scripts/route-list.ts` rewrites it, and scripts/testing/route-list.test.ts fails when it is stale.",
    'import type { RouteListEntry } from "./openapi.ts";',
    "",
    "export const ROUTE_LIST: readonly RouteListEntry[] = [",
    ...lines,
    "];",
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { routes, unresolved } = extract(loadCorpus());
  if (unresolved.length > 0) {
    for (const u of unresolved) console.error(`${u.source}: ${u.why}: ${u.text}`);
    console.error(`route-list: ${unresolved.length} request-path test(s) could not be read; nothing written`);
    process.exit(1);
  }
  const text = render(routes);
  const target = join(ROOT, OUTPUT);
  if (process.argv.includes("--check")) {
    const current = readFileSync(target, "utf8");
    if (current !== text) { console.error(`${OUTPUT} is stale: run node scripts/route-list.ts`); process.exit(1); }
  } else {
    writeFileSync(target, text);
    console.log(`${relative(process.cwd(), target)}: ${routes.length} routes`);
  }
}
