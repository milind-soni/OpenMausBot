// Guards against internal runtime harness notifications leaking into user-facing
// assistant responses. When background tasks or subagents finish, ACP runtimes
// (like Google Antigravity or Anthropic harness) inject notifications into the model
// context using <SYSTEM_MESSAGE> wrappers. Confused or echoing models can sometimes
// regurgitate these blocks into the assistant message stream.

const PREAMBLE_REGEX = /^(?:The following is a|Notice: This is a)\s*<SYSTEM_(?:MESSAGE|NOTIFICATION)>[^\n]*\n?/gim;
const SYSTEM_TAG_BLOCK_REGEX = /(?:(?:The following is a|Notice: This is a)\s*<SYSTEM_(?:MESSAGE|NOTIFICATION)>[^\n]*\n*)?<SYSTEM_(?:MESSAGE|NOTIFICATION)>[\s\S]*?<\/SYSTEM_(?:MESSAGE|NOTIFICATION)>/gi;
const UNCLOSED_SYSTEM_TAG_REGEX = /(?:(?:The following is a|Notice: This is a)\s*<SYSTEM_(?:MESSAGE|NOTIFICATION)>[^\n]*\n*)?<SYSTEM_(?:MESSAGE|NOTIFICATION)>[\s\S]*$/gi;
const ORPHANED_TAG_REGEX = /<\/?SYSTEM_(?:MESSAGE|NOTIFICATION)>/gi;

/** Strips leaked harness system messages and prompt injection preambles from text. */
export function stripLeakedSystemHarnessMessages(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";
  let result = text.replace(SYSTEM_TAG_BLOCK_REGEX, "");
  result = result.replace(UNCLOSED_SYSTEM_TAG_REGEX, "");
  result = result.replace(PREAMBLE_REGEX, "");
  result = result.replace(ORPHANED_TAG_REGEX, "");
  return result.trim();
}

/** Returns true if the message text consists entirely of leaked system harness messages. */
export function isPureLeakedSystemHarnessMessage(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  // If text has system message markers and stripping removes all non-whitespace content:
  const hasMarkers = /<SYSTEM_(?:MESSAGE|NOTIFICATION)>/i.test(text) || /The following is a <SYSTEM_/i.test(text);
  if (!hasMarkers) return false;
  return stripLeakedSystemHarnessMessages(text).length === 0;
}
