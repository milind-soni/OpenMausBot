// A connected-app call refused for a missing OAuth permission (MOCA-273).
//
// Google answers 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT when the account's grant
// lacks a scope the action needs, such as gmail.settings.basic for a filter.
// Composio's default auth config for a toolkit never asks for that scope, so
// reconnecting cannot fix it and a bot that only sees the 403 retries or
// asks the person to reconnect. The fix is the person's own auth config in
// their Composio project, which OpenMausBot already prefers
// (listCustomAuthConfigs). This appends that explanation to the tool result,
// leaving the provider's own error untouched.
//
// Only a call that failed counts. Composio's successful answers quote the
// same 403 wording as documentation (COMPOSIO_SEARCH_TOOLS lists it under
// known_pitfalls), and a note on those stopped bots from reading Gmail at
// all (#2467).

const SCOPE_ERROR = /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i;

/** The Google scope a known tool needs, when the tool name says which. */
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

/** The note a bot reads after its call was refused for a missing permission. */
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

/**
 * Collects the refusals in a parsed Composio answer: objects marked
 * `successful: false`, or carrying an `error`, whose failure is a scope
 * error. Each entry is the tool that failed, when the result names it — a
 * MULTI_EXECUTE batch reports per-tool results under `tool_slug`. The
 * deepest failure wins, so a batch names the tool rather than itself. Text
 * anywhere else, such as a successful search's known_pitfalls, never counts.
 */
function collectRefusals(node: unknown, slug: string | null, found: Array<string | null>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefusals(item, slug, found);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const own = [record.tool_slug, record.slug].find((value): value is string => typeof value === "string" && value !== "") ?? slug;
  const before = found.length;
  for (const value of Object.values(record)) collectRefusals(value, own, found);
  if (found.length > before) return;
  const hasError = record.error !== undefined && record.error !== null && record.error !== "";
  const failed = record.successful === false || (hasError && record.successful !== true);
  // A failed result can carry Google's 403 in `data` rather than `error`.
  if (failed && SCOPE_ERROR.test(JSON.stringify(record.successful === false ? record : record.error))) found.push(own);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Adds the note to one JSON-RPC frame whose tool result is a scope refusal. */
function annotateFrame(frame: unknown, slugs: readonly string[]): boolean {
  const result = (frame as ToolResultFrame | null)?.result;
  if (!result || !Array.isArray(result.content)) return false;
  const texts = result.content.flatMap((item) => {
    const text = (item as { text?: unknown } | null)?.text;
    return typeof text === "string" ? [text] : [];
  });
  const refusals: Array<string | null> = [];
  for (const text of texts) collectRefusals(parseJson(text), null, refusals);
  // A result flagged as an error is a failure as a whole, even when its
  // text is plain or names the 403 outside an error field.
  if (!refusals.length && result.isError === true && texts.some((text) => SCOPE_ERROR.test(text))) refusals.push(null);
  if (!refusals.length) return false;
  const named = refusals.filter((slug): slug is string => slug !== null);
  result.content.push({ type: "text", text: scopeHint(named.length ? named : slugs) });
  return true;
}

/**
 * The relayed MCP response, with the note added when a tool call came back
 * refused for a missing OAuth permission. Anything else, including a body it
 * cannot read, is returned byte for byte.
 */
export function withScopeHint(bytes: Uint8Array, contentType: string, slugs: readonly string[]): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  if (!SCOPE_ERROR.test(text)) return bytes;
  try {
    if (/text\/event-stream/i.test(contentType)) {
      let changed = false;
      const lines = text.split("\n").map((line) => {
        if (!line.startsWith("data:")) return line;
        const frame = JSON.parse(line.slice(5));
        if (!annotateFrame(frame, slugs)) return line;
        changed = true;
        return `data: ${JSON.stringify(frame)}`;
      });
      return changed ? new TextEncoder().encode(lines.join("\n")) : bytes;
    }
    const frame = JSON.parse(text);
    return annotateFrame(frame, slugs) ? new TextEncoder().encode(JSON.stringify(frame)) : bytes;
  } catch {
    return bytes;
  }
}
