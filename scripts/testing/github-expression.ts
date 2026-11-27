// GitHub Actions' expression language, the part ci.yml uses: literals, property paths, ! == != && || and
// parentheses, contains(), fromJSON() and format(). As GitHub evaluates them: && and || return an operand, string
// comparison ignores case, and a missing property is null.
type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

const TOKEN = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|(==|!=|&&|\|\||[!().,[\]])|([A-Za-z_][\w-]*))/y;

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    if (/^\s*$/.test(source.slice(TOKEN.lastIndex))) break;
    const match = TOKEN.exec(source);
    if (!match) throw new Error(`cannot read the expression at ${JSON.stringify(source.slice(TOKEN.lastIndex))}`);
    tokens.push(match[0].trim());
  }
  return tokens;
}

const truthy = (value: Value): boolean => !(value === null || value === false || value === 0 || value === "");
const equal = (a: Value, b: Value): boolean => typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
const text = (value: Value): string => (value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));

const FUNCTIONS: Record<string, (...args: Value[]) => Value> = {
  contains: (search, item) => Array.isArray(search) ? search.some((entry) => equal(entry, item))
    : text(search).toLowerCase().includes(text(item).toLowerCase()),
  fromJSON: (json) => JSON.parse(text(json)) as Value,
  format: (template, ...args) => text(template).replace(/\{(\d+)\}/g, (_, index: string) => text(args[Number(index)] ?? null)),
};

/** The value of one expression (without its `${{ }}`) in `context`. */
export function evaluate(expression: string, context: Record<string, Value>): Value {
  const tokens = tokenize(expression);
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const token = tokens[at++];
    if (expected !== undefined && token !== expected) throw new Error(`expected ${expected}, read ${token}`);
    return token;
  };
  const or = (): Value => {
    let left = and();
    while (peek() === "||") { take(); const right = and(); left = truthy(left) ? left : right; }
    return left;
  };
  const and = (): Value => {
    let left = comparison();
    while (peek() === "&&") { take(); const right = comparison(); left = truthy(left) ? right : left; }
    return left;
  };
  const comparison = (): Value => {
    let left = unary();
    while (peek() === "==" || peek() === "!=") { const op = take(); const right = unary(); left = op === "==" ? equal(left, right) : !equal(left, right); }
    return left;
  };
  const unary = (): Value => {
    if (peek() !== "!") return primary();
    take();
    return !truthy(unary());
  };
  const primary = (): Value => {
    const token = take();
    if (token === "(") { const value = or(); take(")"); return value; }
    if (token.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
    if (/^\d/.test(token)) return Number(token);
    if (token === "true" || token === "false") return token === "true";
    if (token === "null") return null;
    if (peek() === "(") {
      take("(");
      const args: Value[] = [];
      while (peek() !== ")") { args.push(or()); if (peek() === ",") take(","); }
      take(")");
      const fn = FUNCTIONS[token];
      if (!fn) throw new Error(`no function ${token}`);
      return fn(...args);
    }
    let value: Value = context[token] ?? null;
    while (peek() === "." || peek() === "[") {
      const key = take() === "." ? take() : (() => { const index = or(); take("]"); return text(index); })();
      value = value !== null && typeof value === "object" ? (value as Record<string, Value>)[key] ?? null : null;
    }
    return value;
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`unread tokens from ${tokens[at]}`);
  return value;
}

/** A workflow value with `${{ }}` in it, as GitHub fills it in: one whole expression keeps its type. */
export function interpolate(source: string, context: Record<string, Value>): Value {
  const whole = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(source);
  if (whole && !whole[1].includes("}}")) return evaluate(whole[1], context);
  return source.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, inner: string) => text(evaluate(inner, context)));
}
