// Google answers 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT when a grant lacks a scope (gmail.settings.basic for a filter), and
// Composio's default auth config never asks for it, so reconnecting cannot help: the fix is the person's own auth config.
// Only failed calls count: Composio's successful answers quote the same wording (COMPOSIO_SEARCH_TOOLS known_pitfalls).

const SCOPE_ERROR = /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i;

function requiredScope(slug: string): string | null {
  if (!slug.startsWith("GMAIL_")) return null;
  if (/FORWARD|SEND_AS|DELEGATE/.test(slug)) return "https://www.googleapis.com/auth/gmail.settings.sharing";
  if (/FILTER|VACATION|AUTO_REPLY|IMAP|POP|LANGUAGE/.test(slug)) return "https://www.googleapis.com/auth/gmail.settings.basic";
  return null;
}

function appName(slug: string): string {
  const toolkit = slug.split("_")[0] ?? "";
  if (toolkit === "GMAIL") return "Gmail";
  if (toolkit.startsWith("GOOGLE")) return "Google";
  return toolkit.charAt(0) + toolkit.slice(1).toLowerCase();
}

export function scopeHint(slugs: readonly string[]): string {
  const slug = slugs.find((candidate) => requiredScope(candidate)) ?? slugs[0] ?? "";
  const app = slug ? appName(slug) : null;
  const scope = slug ? requiredScope(slug) : null;
  const permission = scope ? `the ${scope} permission` : "the permission this action needs";
  return `OpenMausBot note: ${app ?? "The app"} refused this because the connected account has not granted ${permission}. ` +
    `Reconnecting will not add it: the default Composio connection never asks for it. ` +
    `To allow it, the person creates their own ${app ? `${app} ` : ""}auth config in their Composio project that includes ${permission}, ` +
    `then reconnects ${app ?? "the app"} under Connected apps; OpenMausBot uses that config automatically. ` +
    `Tell the person this. Do not retry this call.`;
}

type ToolResultFrame = { result?: { content?: unknown; isError?: unknown } };

/** Failed objects (`successful: false` or an `error`) whose failure matches `pattern`; the deepest wins, so a MULTI_EXECUTE batch names the tool. */
function collectRefusals(node: unknown, slug: string | null, found: Array<string | null>, pattern: RegExp): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefusals(item, slug, found, pattern);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const own = [record.tool_slug, record.slug].find((value): value is string => typeof value === "string" && value !== "") ?? slug;
  const before = found.length;
  for (const value of Object.values(record)) collectRefusals(value, own, found, pattern);
  if (found.length > before) return;
  const hasError = record.error !== undefined && record.error !== null && record.error !== "";
  const failed = record.successful === false || (hasError && record.successful !== true);
  // A failed result can carry Google's 403 in `data` rather than `error`.
  if (failed && pattern.test(JSON.stringify(record.successful === false ? record : record.error))) found.push(own);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Appends `hint` to a tool result that failed with `pattern`, naming the failed tools or else `slugs`. */
export function annotateFailedCall(
  frame: unknown,
  pattern: RegExp,
  hint: (slugs: readonly string[]) => string,
  slugs: readonly string[],
): boolean {
  const result = (frame as ToolResultFrame | null)?.result;
  if (!result || !Array.isArray(result.content)) return false;
  const texts = result.content.flatMap((item) => {
    const text = (item as { text?: unknown } | null)?.text;
    return typeof text === "string" ? [text] : [];
  });
  const refusals: Array<string | null> = [];
  for (const text of texts) collectRefusals(parseJson(text), null, refusals, pattern);
  // A result flagged isError fails as a whole, even with the 403 outside an error field.
  if (!refusals.length && result.isError === true && texts.some((text) => pattern.test(text))) refusals.push(null);
  if (!refusals.length) return false;
  const named = refusals.filter((slug): slug is string => slug !== null);
  result.content.push({ type: "text", text: hint(named.length ? named : slugs) });
  return true;
}

/** Adds `hint` to each failed tool result in an MCP answer that matches `pattern`. Anything else, an unreadable body
 * included, is returned byte for byte. */
export function withFailedCallHint(
  bytes: Uint8Array,
  contentType: string,
  pattern: RegExp,
  hint: (slugs: readonly string[]) => string,
  slugs: readonly string[],
): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  if (!pattern.test(text)) return bytes;
  try {
    if (/text\/event-stream/i.test(contentType)) {
      let changed = false;
      const lines = text.split("\n").map((line) => {
        if (!line.startsWith("data:")) return line;
        const frame = JSON.parse(line.slice(5));
        if (!annotateFailedCall(frame, pattern, hint, slugs)) return line;
        changed = true;
        return `data: ${JSON.stringify(frame)}`;
      });
      return changed ? new TextEncoder().encode(lines.join("\n")) : bytes;
    }
    const frame = JSON.parse(text);
    return annotateFailedCall(frame, pattern, hint, slugs) ? new TextEncoder().encode(JSON.stringify(frame)) : bytes;
  } catch {
    return bytes;
  }
}

export function withScopeHint(bytes: Uint8Array, contentType: string, slugs: readonly string[]): Uint8Array {
  return withFailedCallHint(bytes, contentType, SCOPE_ERROR, scopeHint, slugs);
}
