// How a model's widget input is read: the children a node names, and what is wrong with a node's type.
export function childNodes(raw: Record<string, unknown>): unknown[] {
  const children = raw.children;
  if (children === undefined || children === null) return [];
  if (Array.isArray(children)) return children;
  if (!isRecord(children)) return [children];
  const keys = Object.keys(children);
  if (keys.length !== 1) return [children];
  const only = children[keys[0]!];
  if (Array.isArray(only)) return only;
  if (isRecord(only)) return [only];
  return [children];
}

/** What is wrong with a node's type, in one sentence that names what to write. */
export function nodeTypeProblem(raw: Record<string, unknown>, known: string): string {
  return raw.type === undefined
    ? `has no type; use one of ${known}`
    : `unknown type ${JSON.stringify(raw.type)}; use one of ${known}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
