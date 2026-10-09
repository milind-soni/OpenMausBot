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
  const app = slug ? appName(slug) : "This app";
  const scope = slug ? requiredScope(slug) : null;
  const permission = scope ? `the ${scope} permission` : "the permission this action needs";
  return `OpenMausBot note: ${app} refused this because the connected account has not granted ${permission}. ` +
    `Reconnecting will not add it: the default Composio connection never asks for it. ` +
    `To allow it, the person creates their own ${app} auth config in their Composio project that includes ${permission}, ` +
    `then reconnects ${app} under Connected apps; OpenMausBot uses that config automatically. ` +
    `Tell the person this. Do not retry this call.`;
}

type ToolResultFrame = { result?: { content?: unknown; isError?: unknown } };

/** Adds the note to one JSON-RPC frame whose tool result is a scope refusal. */
function annotateFrame(frame: unknown, slugs: readonly string[]): boolean {
  const result = (frame as ToolResultFrame | null)?.result;
  if (!result || !Array.isArray(result.content)) return false;
  const refused = result.content.some((item) =>
    item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" &&
    SCOPE_ERROR.test((item as { text: string }).text));
  if (!refused) return false;
  result.content.push({ type: "text", text: scopeHint(slugs) });
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
