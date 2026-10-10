export type ToolScope = {
  allow?: string[];
  deny?: string[];
};

export type ToolIdentity =
  | { kind: "native"; name: string }
  | { kind: "mcp"; server: string; name: string };

type ParsedToolScope = { ok: true; scope: ToolScope | undefined } | { ok: false; error: string };

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
// Selectors must never contain protocol control characters.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const MAX_SELECTORS = 256;
const MAX_SELECTOR_LENGTH = 1024;

function validName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0
    && name.length <= MAX_SELECTOR_LENGTH && !CONTROL_CHARACTER.test(name)
    && !name.includes("*");
}

function selectorIdentity(selector: string): ToolIdentity | undefined {
  if (selector.length > MAX_SELECTOR_LENGTH || CONTROL_CHARACTER.test(selector)) return;
  if (selector.startsWith("native:")) {
    const name = selector.slice(7);
    if (name === "*" || validName(name)) return { kind: "native", name };
  } else if (selector.startsWith("mcp:")) {
    const separator = selector.indexOf(":", 4);
    if (separator < 0) return;
    const server = selector.slice(4, separator);
    const name = selector.slice(separator + 1);
    if (SERVER_NAME.test(server) && (name === "*" || validName(name))) {
      return { kind: "mcp", server, name };
    }
  }
}

/** Undefined inherits the existing catalog. A present invalid value never does. */
export function parseToolScope(value: unknown): ParsedToolScope {
  if (value === undefined) return { ok: true, scope: undefined };
  const invalid = { ok: false, error: "Tool selection must contain only valid allow and deny lists." } as const;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid;
  const scope: ToolScope = {};
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "allow" && key !== "deny") return invalid;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return invalid;
    const list: unknown = descriptor.value;
    if (!Array.isArray(list) || list.length > MAX_SELECTORS) return invalid;
    // Array.from exposes holes as undefined instead of silently skipping them.
    if (!Array.from(list).every((entry: unknown) => typeof entry === "string" && selectorIdentity(entry))) return invalid;
    scope[key] = [...new Set(list as string[])];
  }
  return { ok: true, scope };
}

function matches(selector: string, tool: ToolIdentity): boolean {
  const selected = selectorIdentity(selector);
  return selected?.kind === tool.kind
    && (selected.kind !== "mcp" || (tool.kind === "mcp" && selected.server === tool.server))
    && (selected.name === "*" || selected.name === tool.name);
}

function permits(scope: ToolScope | undefined, tool: ToolIdentity): boolean {
  if (!validName(tool.name) || (tool.kind === "mcp" && !SERVER_NAME.test(tool.server))) return false;
  return (scope?.allow === undefined || scope.allow.some((selector) => matches(selector, tool)))
    && !scope?.deny?.some((selector) => matches(selector, tool));
}

export function allowsTool(scope: unknown, tool: ToolIdentity): boolean {
  const parsed = parseToolScope(scope);
  return parsed.ok && permits(parsed.scope, tool);
}

/** Whether an engine needs a native catalog contract, in addition to MCP gates. */
export function narrowsNativeTools(value: unknown): boolean {
  const parsed = parseToolScope(value);
  if (!parsed.ok) return true;
  const scope = parsed.scope;
  return scope !== undefined && ((scope.allow !== undefined && !scope.allow.includes("native:*"))
    || Boolean(scope.deny?.some((selector) => selector.startsWith("native:"))));
}

/** Without a catalog, asks whether this server could have a permitted tool. */
export function canUseMcpServer(scope: unknown, server: string, names?: readonly string[]): boolean {
  const parsed = parseToolScope(scope);
  if (!parsed.ok || !SERVER_NAME.test(server)) return false;
  if (names !== undefined) {
    return names.some((name) => permits(parsed.scope, { kind: "mcp", server, name }));
  }
  if (parsed.scope?.deny?.includes(`mcp:${server}:*`)) return false;
  if (parsed.scope?.allow === undefined) return true;
  return parsed.scope.allow.some((selector) => {
    const selected = selectorIdentity(selector);
    return selected?.kind === "mcp" && selected.server === server
      && (selected.name === "*" || permits(parsed.scope, selected));
  });
}

/** Compare the selector partitions, including a tool/server outside all exact names. */
export function toolScopeWidens(previous: unknown, next: unknown): boolean {
  const before = parseToolScope(previous);
  const after = parseToolScope(next);
  if (!after.ok) return false;
  const namespaces = new Map<string, Set<string>>([["native", new Set()]]);
  const scopes = [before.ok ? before.scope : undefined, after.scope];
  for (const scope of scopes) {
    for (const selector of [...(scope?.allow ?? []), ...(scope?.deny ?? [])]) {
      const tool = selectorIdentity(selector)!;
      const namespace = tool.kind === "native" ? "native" : `mcp:${tool.server}`;
      if (!namespaces.has(namespace)) namespaces.set(namespace, new Set());
      if (tool.name !== "*") namespaces.get(namespace)!.add(tool.name);
    }
  }
  let server = "unlisted";
  for (let i = 0; namespaces.has(`mcp:${server}`); i++) server = `unlisted${i}`;
  namespaces.set(`mcp:${server}`, new Set());
  for (const [namespace, names] of namespaces) {
    let other = "__unlisted_tool__";
    for (let i = 0; names.has(other); i++) other = `__unlisted_tool_${i}__`;
    names.add(other);
    for (const name of names) {
      const tool: ToolIdentity = namespace === "native" ? { kind: "native", name }
        : { kind: "mcp", server: namespace.slice(4), name };
      if (permits(after.scope, tool) && (!before.ok || !permits(before.scope, tool))) return true;
    }
  }
  return false;
}
