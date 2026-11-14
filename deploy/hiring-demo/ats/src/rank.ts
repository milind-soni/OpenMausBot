// Boolean candidate search (the recruiter-style query) and a deterministic keyword fit score.
import type { Candidate, Requirement } from "./types.ts";

type Token = { kind: "term"; value: string } | { kind: "and" | "or" | "not" | "lparen" | "rparen" };
type Node =
  | { kind: "term"; value: string }
  | { kind: "not"; child: Node }
  | { kind: "and" | "or"; left: Node; right: Node };

function bad(reason: string): never {
  throw new Error(`Bad Boolean query: ${reason}`);
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(") { tokens.push({ kind: "lparen" }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen" }); i++; continue; }
    if (ch === '"') {
      const end = query.indexOf('"', i + 1);
      if (end === -1) bad("unclosed quote");
      const phrase = query.slice(i + 1, end).trim().toLowerCase();
      if (phrase) tokens.push({ kind: "term", value: phrase });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < query.length && !/[\s()"]/.test(query[j]!)) j++;
    const word = query.slice(i, j);
    if (word === "AND") tokens.push({ kind: "and" });
    else if (word === "OR") tokens.push({ kind: "or" });
    else if (word === "NOT") tokens.push({ kind: "not" });
    else tokens.push({ kind: "term", value: word.toLowerCase() });
    i = j;
  }
  return tokens;
}

// Precedence: NOT > AND (explicit or adjacency) > OR.
function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const startsOperand = (t: Token | undefined) => t?.kind === "term" || t?.kind === "lparen" || t?.kind === "not";

  function parseOr(): Node {
    let left = parseAnd();
    while (peek()?.kind === "or") {
      pos++;
      left = { kind: "or", left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd(): Node {
    let left = parseUnary();
    for (;;) {
      if (peek()?.kind === "and") { pos++; left = { kind: "and", left, right: parseUnary() }; continue; }
      if (startsOperand(peek())) { left = { kind: "and", left, right: parseUnary() }; continue; }
      return left;
    }
  }
  function parseUnary(): Node {
    const t = peek();
    if (!t) bad("expected a term");
    if (t.kind === "not") { pos++; return { kind: "not", child: parseUnary() }; }
    if (t.kind === "lparen") {
      pos++;
      const inner = parseOr();
      if (peek()?.kind !== "rparen") bad("missing closing parenthesis");
      pos++;
      return inner;
    }
    if (t.kind === "term") { pos++; return { kind: "term", value: t.value }; }
    return bad(`unexpected ${t.kind.toUpperCase()}`);
  }

  const node = parseOr();
  if (pos < tokens.length) bad(`unexpected ${tokens[pos]!.kind === "rparen" ? ")" : tokens[pos]!.kind}`);
  return node;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word (or whole-phrase) match that also works for terms like "c#" and ".net". */
function hasTerm(haystack: string, term: string): boolean {
  return new RegExp(`(?<![a-z0-9])${escape(term)}(?![a-z0-9])`).test(haystack);
}

function evaluate(node: Node, text: string): boolean {
  switch (node.kind) {
    case "term": return hasTerm(text, node.value);
    case "not": return !evaluate(node.child, text);
    case "and": return evaluate(node.left, text) && evaluate(node.right, text);
    case "or": return evaluate(node.left, text) || evaluate(node.right, text);
  }
}

function searchText(c: Candidate): string {
  return [c.title, c.skills.join(" , "), c.resume, c.location].join(" \n ").toLowerCase();
}

export function matchesQuery(query: string, candidate: Candidate): boolean {
  const tokens = tokenize(query);
  if (tokens.length === 0) return true;
  return evaluate(parse(tokens), searchText(candidate));
}

function cityState(location: string): { city: string; state: string } {
  const [city = "", state = ""] = location.split(",").map((s) => s.trim().toLowerCase());
  return { city, state };
}

/** 0–100: skills 60, years 20, location 10 (5 for same state), rate 10 (linear to 0 at rate + 10). */
export function keywordScore(
  candidate: Candidate,
  req: Pick<Requirement, "skills" | "minYears" | "location" | "workMode" | "rate">,
): number {
  const own = new Set(candidate.skills.map((s) => s.toLowerCase()));
  const resume = candidate.resume.toLowerCase();
  const found = req.skills.filter((s) => own.has(s.toLowerCase()) || hasTerm(resume, s.toLowerCase())).length;
  const skills = req.skills.length ? (60 * found) / req.skills.length : 60;

  const years = req.minYears > 0 ? 20 * Math.min(1, candidate.years / req.minYears) : 20;

  const want = cityState(req.location);
  const have = cityState(candidate.location);
  const location = req.workMode === "remote" || candidate.relocate || (want.city && want.city === have.city)
    ? 10
    : want.state && want.state === have.state ? 5 : 0;

  const over = candidate.rateExpectation - req.rate;
  const rate = over <= 0 ? 10 : over >= 10 ? 0 : 10 * (1 - over / 10);

  return Math.round(skills + years + location + rate);
}
