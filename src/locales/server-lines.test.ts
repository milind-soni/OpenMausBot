// The lines the server writes for a person to read come from the language packs (the "server." keys, through
// serverLine in server/server-lines.ts), in the language of the person they are for. This guard reads the server's
// code and fails on an English line written straight into one. It starts where a line is made: a bot line's text
// (an object with role "bot"), a status row's name (its tool's name), a card (card, connector, signIn, secret,
// routineRun, goalRun), a notification's title and body, a line's text patched in later, and what is handed to a
// notice(...) callback. From there it follows what flows in: literals, templates, conditionals, a const, what a helper
// returns (in the same file or a file it imports) and what a same-file helper is called with.
// Text only a model reads, an id or a tool's name is no line: ALLOWED says why. PENDING holds the lines written before
// this guard, by area. It only shrinks: an area's pull request moves its lines into the packs and deletes them here.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import de from "./de.json";
import en from "./en.json";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCANNED = ["server", "shared"];
const SKIPPED_DIRS = new Set(["node_modules", "testing", "dist", "resources"]);
const isSource = (name: string) => name.endsWith(".ts") && !/\.test\.|\.d\.ts$/.test(name);

/** Words, not an id or a tool's name: two words of letters with a space between. */
const english = (text: string) => /[A-Za-z]{2,}[,.:;!?'’)]*\s+[(“"]?[A-Za-z]{2,}/.test(text);
/** In an object a line is made from, the properties a person reads. */
const SHOWN = new Set(["text", "line", "title", "question", "label", "detail", "note", "body", "summary", "hint", "prompt",
  "description", "subtitle", "message", "reason", "button", "placeholder", "caption"]);
const CARDS = new Set(["card", "connector", "signIn", "secret", "routineRun", "goalRun"]);
/** Helpers whose result is their first argument's words, shortened or cleaned. */
const PASS_THROUGH = new Set(["summarize", "clip", "oneLine", "truncate", "redactSecretsInText", "String"]);
/** String methods whose result keeps the words of what they are called on. */
const KEEPS_WORDS = new Set(["join", "trim", "trimEnd", "trimStart", "slice", "replace", "replaceAll", "concat", "toString"]);

/** `sink`: where the line is made, as "status row at server/x.ts:12". */
export interface Finding { file: string; line: number; text: string; sink: string }

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
interface Source {
  sf: ts.SourceFile;
  decls: Map<string, ts.FunctionDeclaration | ts.VariableDeclaration>;
  imports: Map<string, { file: string; name: string }>;
  calls?: Map<string, ts.CallExpression[]>;
}

const nameOf = (node: ts.PropertyName | ts.Identifier) => node.getText().replace(/^["']|["']$/g, "");
const isFunction = (node: ts.Node | undefined): node is FunctionLike => Boolean(node)
  && (ts.isFunctionDeclaration(node!) || ts.isArrowFunction(node!) || ts.isFunctionExpression(node!) || ts.isMethodDeclaration(node!));

/** The English lines that reach a person in `paths`. `read` gives a file's text, or null when there is none. */
export function findServerLines(paths: readonly string[], read: (path: string) => string | null, root: string): Finding[] {
  const sources = new Map<string, Source | null>();
  const findings = new Map<string, Finding>();

  function load(path: string): Source | null {
    if (sources.has(path)) return sources.get(path)!;
    const text = read(path);
    if (text === null) {
      sources.set(path, null);
      return null;
    }
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    // The file's own top-level names: what another file can import. Names inside a function are found from the use.
    const decls = new Map<string, ts.FunctionDeclaration | ts.VariableDeclaration>();
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) decls.set(statement.name.text, statement);
      else if (ts.isVariableStatement(statement)) {
        for (const one of statement.declarationList.declarations) if (ts.isIdentifier(one.name) && one.initializer) decls.set(one.name.text, one);
      }
    }
    const imports = new Map<string, { file: string; name: string }>();
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings, specifier = statement.moduleSpecifier.text;
      if (!bindings || !ts.isNamedImports(bindings) || !specifier.startsWith(".") || !specifier.endsWith(".ts")) continue;
      const file = resolve(dirname(path), specifier);
      for (const element of bindings.elements) imports.set(element.name.text, { file, name: (element.propertyName ?? element.name).text });
    }
    const source = { sf, decls, imports };
    sources.set(path, source);
    return source;
  }

  function report(source: Source, node: ts.Node, text: string, sink: string): void {
    const line = source.sf.getLineAndCharacterOfPosition(node.getStart(source.sf)).line + 1;
    const file = relative(root, source.sf.fileName).split("\\").join("/");
    findings.set(`${file}:${line}:${text}`, { file, line, text, sink });
  }

  function callsTo(source: Source, name: string): ts.CallExpression[] {
    if (!source.calls) {
      const calls = new Map<string, ts.CallExpression[]>();
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.set(node.expression.text, [...(calls.get(node.expression.text) ?? []), node]);
        ts.forEachChild(node, visit);
      };
      visit(source.sf);
      source.calls = calls;
    }
    return source.calls.get(name) ?? [];
  }

  /** The function `name` is a parameter of, at the use, and its position. */
  function parameterOf(node: ts.Node, name: string): { fn: FunctionLike; index: number } | null {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      if (!isFunction(at)) continue;
      const index = at.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name);
      if (index >= 0) return { fn: at, index };
    }
    return null;
  }

  function functionName(fn: FunctionLike): string | null {
    if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? null;
    return ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : null;
  }

  /** The calls to a named function within the block it is declared in. */
  function callsOf(source: Source, fn: FunctionLike): ts.CallExpression[] {
    const name = functionName(fn);
    if (!name) return [];
    let scope: ts.Node | undefined = ts.isFunctionDeclaration(fn) ? fn.parent : fn.parent.parent;
    while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isModuleBlock(scope)) scope = scope.parent;
    return callsTo(source, name).filter((call) => !scope || (call.pos >= scope.pos && call.end <= scope.end));
  }

  function returnsOf(fn: FunctionLike): ts.Expression[] {
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
    const found: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if (node !== fn && isFunction(node)) return;
      if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
      ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
    return found;
  }

  /** The nearest declaration of `name` in scope at the use, else the file's. */
  function declarationOf(source: Source, node: ts.Node, name: string): ts.FunctionDeclaration | ts.VariableDeclaration | null {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      if (!ts.isBlock(at) && !ts.isSourceFile(at) && !ts.isModuleBlock(at)) continue;
      for (const statement of at.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
        if (!ts.isVariableStatement(statement)) continue;
        const found = statement.declarationList.declarations.find((one) => ts.isIdentifier(one.name) && one.name.text === name && one.initializer);
        if (found) return found;
      }
    }
    return source.decls.get(name) ?? null;
  }

  /** What `name` names at `node`: a declaration here, else the one it is imported from. */
  function resolveName(source: Source, node: ts.Node, name: string): { source: Source; decl: ts.FunctionDeclaration | ts.VariableDeclaration } | null {
    const local = declarationOf(source, node, name);
    if (local) return { source, decl: local };
    const imported = source.imports.get(name);
    const target = imported ? load(imported.file) : null;
    const decl = imported && target ? target.decls.get(imported.name) : undefined;
    return target && decl ? { source: target, decl } : null;
  }

  const functionOf = (decl: ts.FunctionDeclaration | ts.VariableDeclaration): FunctionLike | null =>
    ts.isFunctionDeclaration(decl) ? decl : isFunction(decl.initializer) ? decl.initializer : null;

  function trace(source: Source, expr: ts.Node | undefined, sink: string, seen: Set<string>, depth = 0): void {
    if (!expr || depth > 14) return;
    const key = `${source.sf.fileName}:${expr.pos}:${expr.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    const next = (node: ts.Node | undefined, from: Source = source) => trace(from, node, sink, seen, depth + 1);
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      if (english(expr.text)) report(source, expr, expr.text, sink);
    } else if (ts.isTemplateExpression(expr)) {
      const words = [expr.head.text, ...expr.templateSpans.map((span) => span.literal.text)].join(" … ");
      if (english(words)) report(source, expr, words, sink);
      for (const span of expr.templateSpans) next(span.expression);
    } else if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)
      || ts.isTypeAssertionExpression(expr) || ts.isAwaitExpression(expr)) {
      next(expr.expression);
    } else if (ts.isConditionalExpression(expr)) {
      next(expr.whenTrue);
      next(expr.whenFalse);
    } else if (ts.isBinaryExpression(expr)) {
      const kind = expr.operatorToken.kind;
      if (kind === ts.SyntaxKind.PlusToken || kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken
        || kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        next(expr.left);
        next(expr.right);
      }
    } else if (ts.isArrayLiteralExpression(expr)) {
      for (const element of expr.elements) next(element);
    } else if (ts.isSpreadElement(expr)) {
      next(expr.expression);
    } else if (ts.isIdentifier(expr)) {
      const parameter = parameterOf(expr, expr.text);
      if (parameter) {
        for (const call of callsOf(source, parameter.fn)) next(call.arguments[parameter.index]);
        return;
      }
      const named = resolveName(source, expr, expr.text);
      if (named && ts.isVariableDeclaration(named.decl) && !isFunction(named.decl.initializer)) next(named.decl.initializer, named.source);
    } else if (ts.isCallExpression(expr)) {
      const callee = expr.expression;
      if (ts.isPropertyAccessExpression(callee) && KEEPS_WORDS.has(callee.name.text)) {
        next(callee.expression);
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "map") {
        const mapper = expr.arguments[0];
        if (isFunction(mapper)) for (const result of returnsOf(mapper)) next(result);
      } else if (ts.isIdentifier(callee) && callee.text === "serverLine") {
        // The words the line's {names} are filled with.
        const params = expr.arguments[2];
        if (params && ts.isObjectLiteralExpression(params)) {
          for (const one of params.properties) {
            if (ts.isPropertyAssignment(one)) next(one.initializer);
            else if (ts.isShorthandPropertyAssignment(one)) next(one.name);
            else if (ts.isSpreadAssignment(one)) next(one.expression);
          }
        } else next(params);
      } else if (ts.isIdentifier(callee) && PASS_THROUGH.has(callee.text)) {
        next(expr.arguments[0]);
      } else if (ts.isIdentifier(callee)) {
        const named = resolveName(source, expr, callee.text);
        const fn = named ? functionOf(named.decl) : null;
        if (named && fn) for (const result of returnsOf(fn)) next(result, named.source);
      }
    } else if (ts.isObjectLiteralExpression(expr)) {
      for (const property of expr.properties) {
        if (ts.isPropertyAssignment(property) && SHOWN.has(nameOf(property.name))) next(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property) && SHOWN.has(property.name.text)) next(property.name);
        else if (ts.isSpreadAssignment(property)) next(property.expression);
      }
    } else if (ts.isPropertyAccessExpression(expr)) {
      for (const object of objectsOf(source, expr.expression, new Set(), 0)) {
        const property = object.node.properties.find((one) => (ts.isPropertyAssignment(one) || ts.isShorthandPropertyAssignment(one))
          && nameOf(one.name) === expr.name.text);
        if (property) next(ts.isPropertyAssignment(property) ? property.initializer : property.name, object.source);
      }
    }
  }

  /** The object literals an expression can be. */
  function objectsOf(source: Source, expr: ts.Node | undefined, seen: Set<string>, depth: number): Array<{ source: Source; node: ts.ObjectLiteralExpression }> {
    if (!expr || depth > 10) return [];
    const key = `${source.sf.fileName}:${expr.pos}:${expr.end}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const next = (node: ts.Node | undefined, from: Source = source) => objectsOf(from, node, seen, depth + 1);
    if (ts.isObjectLiteralExpression(expr)) return [{ source, node: expr }];
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)
      || ts.isAwaitExpression(expr)) return next(expr.expression);
    if (ts.isConditionalExpression(expr)) return [...next(expr.whenTrue), ...next(expr.whenFalse)];
    if (ts.isBinaryExpression(expr)) return [...next(expr.left), ...next(expr.right)];
    if (ts.isIdentifier(expr)) {
      const parameter = parameterOf(expr, expr.text);
      if (parameter) return callsOf(source, parameter.fn).flatMap((call) => next(call.arguments[parameter.index]));
      const named = resolveName(source, expr, expr.text);
      return named && ts.isVariableDeclaration(named.decl) ? next(named.decl.initializer, named.source) : [];
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      const named = resolveName(source, expr, expr.expression.text);
      const fn = named ? functionOf(named.decl) : null;
      return named && fn ? returnsOf(fn).flatMap((result) => next(result, named.source)) : [];
    }
    return [];
  }

  const property = (object: ts.ObjectLiteralExpression, name: string) => object.properties.find((one): one is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
    (ts.isPropertyAssignment(one) || ts.isShorthandPropertyAssignment(one)) && nameOf(one.name) === name);
  const valueOf = (one: ts.PropertyAssignment | ts.ShorthandPropertyAssignment) => (ts.isPropertyAssignment(one) ? one.initializer : one.name);

  for (const path of paths) {
    const source = load(path);
    if (!source) continue;
    const at = (node: ts.Node, what: string) =>
      `${what} at ${relative(root, source.sf.fileName).split("\\").join("/")}:${source.sf.getLineAndCharacterOfPosition(node.getStart(source.sf)).line + 1}`;
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const role = property(node, "role");
        if (role && ts.isPropertyAssignment(role) && ts.isStringLiteral(role.initializer) && role.initializer.text === "bot") {
          for (const one of node.properties) {
            if (!ts.isPropertyAssignment(one) && !ts.isShorthandPropertyAssignment(one)) continue;
            const name = nameOf(one.name);
            if (name === "text") trace(source, valueOf(one), at(node, "line"), new Set());
            else if (CARDS.has(name)) trace(source, valueOf(one), at(node, `card ${name}`), new Set());
            else if (name === "tool") {
              for (const tool of objectsOf(source, valueOf(one), new Set(), 0)) {
                const toolName = property(tool.node, "name");
                if (toolName) trace(tool.source, valueOf(toolName), at(node, "status row"), new Set());
              }
            }
          }
        }
        const title = property(node, "title"), body = property(node, "body");
        if (property(node, "botId") && title && body) {
          trace(source, valueOf(title), at(node, "notification"), new Set());
          trace(source, valueOf(body), at(node, "notification"), new Set());
        }
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const called = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        if (called === "patchMessage" && node.arguments[2] && ts.isObjectLiteralExpression(node.arguments[2])) {
          const text = property(node.arguments[2], "text");
          if (text) trace(source, valueOf(text), at(node, "line"), new Set());
        } else if (called === "notice") {
          for (const argument of node.arguments) trace(source, argument, at(node, "notice"), new Set());
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source.sf);
  }
  return [...findings.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (isSource(name)) yield path;
  }
}

const readTree = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** English on purpose: what reaches a line here is not words a person reads in it. */
const ALLOWED: ReadonlyArray<{ file: string; snippet: string; why: string }> = [
  { file: "server/host/helper-suggestion.ts", snippet: "Want me to sort your email for free?", why: "the app draws this suggestion in its own words (setupSuggestion)" },
  { file: "shared/client-cancel.ts", snippet: "You stopped this.", why: "a stopped turn's marker: the app says it in the reader's language (chat.turnStopped)" },
];

/** Lines written before this guard, by area: a file and the line's words (" … " where a value goes). Only shrinks. */
const PENDING: Readonly<Record<string, ReadonlyArray<readonly [file: string, snippet: string]>>> = {
  "computers and the browser": [
    ["server/browser/viewers/stream-v2.ts", "The browser could not restart. Wait for active work to finish and try"],
  ],
  "questions, approvals and setup cards": [
    ["server/default-bot.ts", "Hey! I'm  … . I'm new here."],
    ["server/default-bot.ts", "Hi! I'm  … , your helper for everything here."],
  ],
  "restarts, stops and context": [
    ["shared/first-reply-rescue.ts", "notice:  …  hasn't heard back from  …  yet."],
  ],
  "calls": [
    ["shared/live-call.ts", "Call with  …  ·  …"],
  ],
};

const listed = (finding: Finding, file: string, snippet: string) => finding.file === file && finding.text.includes(snippet);

describe("lines the server writes for a person", () => {
  const findings = findServerLines(SCANNED.flatMap((top) => [...sources(join(ROOT, top))]), readTree, ROOT);
  const pending = Object.values(PENDING).flat();

  it("come from the language packs, never as English written into the code", () => {
    const offending = findings
      .filter((finding) => !ALLOWED.some((one) => listed(finding, one.file, one.snippet)) && !pending.some(([file, snippet]) => listed(finding, file, snippet)))
      .map((finding) => `${finding.file}:${finding.line}: ${JSON.stringify(finding.text.slice(0, 140))} (${finding.sink})`);
    // A line a person reads: add its words under "server." in en.json (and de.json), and write it with serverLine() in
    // the language lineLanguage gives for the person it is for. Text only a model reads: add it to ALLOWED with why.
    expect(offending).toEqual([]);
  });

  it("lists only lines that are still there", () => {
    const stale = [
      ...ALLOWED.filter((one) => !findings.some((finding) => listed(finding, one.file, one.snippet))).map((one) => `ALLOWED ${one.file}: ${one.snippet}`),
      ...pending.filter(([file, snippet]) => !findings.some((finding) => listed(finding, file, snippet))).map(([file, snippet]) => `PENDING ${file}: ${snippet}`),
    ];
    // Translated or gone: delete it here.
    expect(stale).toEqual([]);
  });

  it("every server line has German words, and the server uses each one", () => {
    const keys = Object.keys(en).filter((key) => key.startsWith("server."));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !Object.hasOwn(de, key))).toEqual([]);
    const code = SCANNED.flatMap((top) => [...sources(join(ROOT, top))]).map((path) => readFileSync(path, "utf8")).join("\n");
    expect(keys.filter((key) => !code.includes(`"${key}"`))).toEqual([]);
  });

  it("only server-lines.ts (English) and server-line-packs.ts (the rest) read the language packs on the server", () => {
    const readers = SCANNED.flatMap((top) => [...sources(join(ROOT, top))])
      .filter((path) => /from ["'][./]+\/src\/locales\//.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path).split("\\").join("/"));
    expect(readers.sort()).toEqual(["server/server-line-packs.ts", "server/server-lines.ts"]);
    // The server loads the other languages when it starts; without them every line reads in English.
    expect(readFileSync(join(ROOT, "server/index.ts"), "utf8")).toMatch(/(?:^|;\s*)import "\.\/server-line-packs\.ts";/m);
  });

  it("tells every module the language of a conversation's person (server/server-lines.ts)", () => {
    expect(readFileSync(join(ROOT, "server/index.ts"), "utf8")).toContain("setConversationLanguage(threadLanguage);");
  });
});

describe("the guard", () => {
  const ROOT_HERE = "/repo";
  const scan = (files: Record<string, string>) =>
    findServerLines(Object.keys(files).map((file) => `${ROOT_HERE}/${file}`), (path) => files[relative(ROOT_HERE, path).split("\\").join("/")] ?? null, ROOT_HERE)
      .map((finding) => `${finding.file} ${finding.sink.replace(/ at \S+$/, "")}: ${finding.text}`);

  it("finds a new English line in each place a line is made", () => {
    expect(scan({
      "server/a.ts": [
        `import { reportLine } from "./lines.ts";`,
        `const DONE = "The report went to the team.";`,
        `const failed = (why: string) => \`Could not send it: \${why}.\`;`,
        `function tell(threadId: string, text: string) { store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: \`notice: \${text}\` } }); }`,
        `store.appendMessage(id, { role: "bot", kind: "text", text: "Your report is on its way." });`,
        `store.appendMessage(id, { role: "bot", kind: "text", text: ok ? DONE : failed("offline") });`,
        `tell(id, "Sent to the team just now.");`,
        `store.appendMessage(id, { role: "bot", kind: "text", text: reportLine(id) });`,
        `store.patchMessage(id, line, { text: \`Finished at \${time}\` });`,
        `const note = { kind: "done", botId: bot.id, title: \`\${bot.name} finished the job\`, body };`,
        `deps.notice(\`Switched to \${name} after the limit.\`);`,
        `store.appendMessage(id, { role: "bot", kind: "options", card: { title: "Send on your behalf?", options } });`,
      ].join("\n"),
      "server/lines.ts": `export function reportLine(id: string): string { return \`Report \${id} is saved for later.\`; }`,
    })).toEqual([
      "server/a.ts line: The report went to the team.",
      "server/a.ts line: Could not send it:  … .",
      "server/a.ts line: Your report is on its way.",
      "server/a.ts status row: Sent to the team just now.",
      "server/a.ts line: Finished at  … ",
      "server/a.ts notification:  …  finished the job",
      "server/a.ts notice: Switched to  …  after the limit.",
      "server/a.ts card card: Send on your behalf?",
      "server/lines.ts line: Report  …  is saved for later.",
    ]);
  });

  it("lets through a line from the packs, an id, a tool's name and text no line is made of", () => {
    expect(scan({
      "server/b.ts": [
        `const language = lineLanguage(person);`,
        `store.appendMessage(id, { role: "bot", kind: "text", text: serverLine(language, "server.reports.sent", { report: id }) });`,
        `store.appendMessage(id, { role: "bot", kind: "activity", tool: { name: "data_show", ok: true } });`,
        `store.appendMessage(id, { role: "bot", kind: "text", text: reply.text });`,
        `const prompt = "Tell the person what you found, in their language.";`,
        `store.appendMessage(id, { role: "user", kind: "text", text: "A person's own words are theirs." });`,
      ].join("\n"),
    })).toEqual([]);
  });

  it("finds English handed to a line from the packs", () => {
    expect(scan({ "server/c.ts": `store.appendMessage(id, { role: "bot", kind: "text", text: serverLine(language, "server.reports.notYet", { why: "the server is down", when }) });` }))
      .toEqual(["server/c.ts line: the server is down"]);
  });
});
