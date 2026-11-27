// Guards against internal runtime harness notifications, turn summaries,
// internal coordination tags, and naked bot telemetry JSON leaking into
// user-facing assistant responses. When background tasks or subagents finish,
// ACP runtimes or multi-agent orchestrators inject notifications or context blocks
// into the model context. Confused or echoing models can sometimes regurgitate
// these blocks into the assistant message stream.

const PREAMBLE_REGEX = /^(?:The following is a|Notice: This is a)\s*<SYSTEM_(?:MESSAGE|NOTIFICATION)>[^\n]*\n?/gim;
const SYSTEM_TAG_BLOCK_REGEX = /(?:(?:The following is a|Notice: This is a)\s*<SYSTEM_(?:MESSAGE|NOTIFICATION)>[^\n]*\n*)?<SYSTEM_(?:MESSAGE|NOTIFICATION)>[\s\S]*?<\/SYSTEM_(?:MESSAGE|NOTIFICATION)>/gi;
const UNCLOSED_SYSTEM_TAG_REGEX = /(?:(?:The following is a|Notice: This is a)\s*<SYSTEM_(?:MESSAGE|NOTIFICATION)>[^\n]*\n*)?<SYSTEM_(?:MESSAGE|NOTIFICATION)>[\s\S]*$/gi;
const ORPHANED_TAG_REGEX = /<\/?SYSTEM_(?:MESSAGE|NOTIFICATION)>/gi;

interface TextRange {
  start: number;
  end: number;
}

function protectCodeSpans(text: string): { masked: string; restore: (cleaned: string) => string } {
  const codeBlocks: string[] = [];

  const FENCED = /(^|\n)([ \t]{0,3})(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n[ \t]{0,3}\3[^\n]*(?=\n|$)|$)|$)/g;
  let masked = text.replace(FENCED, (match, nl: string, indent: string) => {
    const token = `\u0000GUARD_CODE_${codeBlocks.length}\u0000`;
    const prefix = nl + indent;
    codeBlocks.push(match.slice(prefix.length));
    return prefix + token;
  });

  const INDENTED = /(^|\n)((?:(?: {4}|\t)[^\n]*(?:\r?\n|$))+)/g;
  masked = masked.replace(INDENTED, (match, nl: string, content: string) => {
    if (content.includes("\u0000GUARD_CODE_")) return match;
    const token = `\u0000GUARD_CODE_${codeBlocks.length}\u0000`;
    codeBlocks.push(content);
    return nl + token;
  });

  const INLINE = /(`+)(?:[^\n`]|\\`)*?\1/g;
  masked = masked.replace(INLINE, (match) => {
    if (match.includes("\u0000GUARD_CODE_")) return match;
    const token = `\u0000GUARD_CODE_${codeBlocks.length}\u0000`;
    codeBlocks.push(match);
    return token;
  });

  const restore = (cleaned: string): string => {
    // oxlint-disable-next-line no-control-regex -- restore opaque code sentinels
    return cleaned.replace(/\u0000GUARD_CODE_(\d+)\u0000/g, (_m, idxStr) => {
      const idx = Number(idxStr);
      return codeBlocks[idx] ?? "";
    });
  };

  return { masked, restore };
}

function removeRanges(text: string, ranges: TextRange[]): string {
  if (ranges.length === 0) return text;

  const sorted = [...ranges].sort((a, b) => a.start - b.start);

  const adjusted: TextRange[] = [];
  for (const r of sorted) {
    let { start, end } = r;

    const isLineStart = start === 0 || text[start - 1] === "\n";
    const isLineEnd = end === text.length || text[end] === "\n" || (text[end] === "\r" && text[end + 1] === "\n");

    if (isLineStart && isLineEnd) {
      if (end < text.length) {
        if (text[end] === "\r" && text[end + 1] === "\n") {
          end += 2;
        } else if (text[end] === "\n") {
          end += 1;
        }
      }
    } else {
      if (end < text.length && text[end] === " ") {
        if (start > 0 && text[start - 1] === " ") {
          end += 1;
        } else if (start > 0 && /[，。！？；、]/.test(text[start - 1])) {
          end += 1;
        }
      } else if (start > 0 && text[start - 1] === " " && end < text.length && /[，。！？；、]/.test(text[end])) {
        start -= 1;
      }
    }

    adjusted.push({ start, end });
  }

  const merged: TextRange[] = [];
  for (const r of adjusted) {
    if (merged.length === 0) {
      merged.push(r);
    } else {
      const prev = merged[merged.length - 1];
      if (r.start <= prev.end) {
        prev.end = Math.max(prev.end, r.end);
      } else {
        merged.push(r);
      }
    }
  }

  let result = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const { start, end } = merged[i];
    result = result.slice(0, start) + result.slice(end);
  }

  return result;
}

function stripEarlierTurnSummaries(text: string): string {
  const pattern = /(?:(?:^|\n)\s*)?(?:\[|\()?\s*What\s+[^\n:]{1,100}\s+did\s+in\s+an\s+earlier\s+turn:/gi;
  let match: RegExpExecArray | null;
  const ranges: TextRange[] = [];

  while ((match = pattern.exec(text)) !== null) {
    const startIdx = match.index;
    const matchStr = match[0];
    const hasBracket = matchStr.includes("(") || matchStr.includes("[");
    let endIdx = text.length;

    if (hasBracket) {
      let depth = 0;
      let closed = false;
      for (let i = startIdx; i < text.length; i++) {
        const c = text[i];
        if (c === "(" || c === "[") {
          depth++;
        } else if (c === ")" || c === "]") {
          depth--;
          if (depth <= 0) {
            endIdx = i + 1;
            closed = true;
            break;
          }
        }
      }
      if (!closed) {
        const nextDbl = text.indexOf("\n\n", match.index + matchStr.length);
        endIdx = nextDbl === -1 ? text.length : nextDbl;
      }
    } else {
      const nextDbl = text.indexOf("\n\n", match.index + matchStr.length);
      endIdx = nextDbl === -1 ? text.length : nextDbl;
    }
    ranges.push({ start: startIdx, end: endIdx });
  }

  return removeRanges(text, ranges);
}

function stripFromMetaTags(text: string): string {
  const pattern = /(?:(?:^|\n)\s*)?(?:\[|\()?\s*From\s+@[^\n\]):]{1,100}(?:·|\((?:bot|person)\)|\[(?:bot|person)\])/gi;
  let match: RegExpExecArray | null;
  const ranges: TextRange[] = [];

  while ((match = pattern.exec(text)) !== null) {
    const startIdx = match.index;
    const matchStr = match[0];
    const hasBracket = matchStr.includes("(") || matchStr.includes("[");
    let endIdx = text.length;

    if (hasBracket) {
      let depth = 0;
      let closed = false;
      for (let i = startIdx; i < text.length; i++) {
        const c = text[i];
        if (c === "(" || c === "[") {
          depth++;
        } else if (c === ")" || c === "]") {
          depth--;
          if (depth <= 0) {
            endIdx = i + 1;
            closed = true;
            break;
          }
        }
      }
      if (!closed) {
        const nextNl = text.indexOf("\n", match.index + matchStr.length);
        endIdx = nextNl === -1 ? text.length : nextNl;
      }
    } else {
      const nextNl = text.indexOf("\n", match.index + matchStr.length);
      endIdx = nextNl === -1 ? text.length : nextNl;
    }
    ranges.push({ start: startIdx, end: endIdx });
  }

  return removeRanges(text, ranges);
}

function stripCoordinationJson(text: string): string {
  const BOT_KEY_REGEX = /\{\s*"bot"\s*:/gi;
  let match: RegExpExecArray | null;
  const ranges: TextRange[] = [];

  while ((match = BOT_KEY_REGEX.exec(text)) !== null) {
    const startIdx = match.index;
    let braceDepth = 0;
    let inString = false;
    let escape = false;
    let endIdx = text.length;

    for (let i = startIdx; i < text.length; i++) {
      const c = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (c === "{") {
          braceDepth++;
        } else if (c === "}") {
          braceDepth--;
          if (braceDepth <= 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
    }

    const candidate = text.slice(startIdx, endIdx);
    const isCoordination = /"(?:task|result|status|thread|brief|threadId|conversationId|assignment)"\s*:/i.test(candidate);
    if (isCoordination) {
      ranges.push({ start: startIdx, end: endIdx });
      BOT_KEY_REGEX.lastIndex = endIdx;
    }
  }

  return removeRanges(text, ranges);
}

/** Strips leaked harness system messages, turn summaries, From tags, and raw coordination JSON from text. */
export function stripLeakedSystemHarnessMessages(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";

  const { masked, restore } = protectCodeSpans(text);

  let filtered = masked.replace(SYSTEM_TAG_BLOCK_REGEX, "");
  filtered = filtered.replace(UNCLOSED_SYSTEM_TAG_REGEX, "");
  filtered = filtered.replace(PREAMBLE_REGEX, "");
  filtered = filtered.replace(ORPHANED_TAG_REGEX, "");

  filtered = stripEarlierTurnSummaries(filtered);
  filtered = stripFromMetaTags(filtered);
  filtered = stripCoordinationJson(filtered);
  filtered = filtered.replace(/\n{3,}/g, "\n\n");

  const result = restore(filtered);
  return result.trim();
}

const SYSTEM_OR_TELEMETRY_MARKERS = /(?:<SYSTEM_(?:MESSAGE|NOTIFICATION)>|The following is a <SYSTEM_|What\s+[^\n:]{1,100}\s+did\s+in\s+an\s+earlier\s+turn:|From\s+@[^\n\])]{1,80}|"bot"\s*:)/i;

/** Returns true if the message text consists entirely of leaked system harness messages or internal coordination telemetry. */
export function isPureLeakedSystemHarnessMessage(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  if (!SYSTEM_OR_TELEMETRY_MARKERS.test(text)) return false;
  return stripLeakedSystemHarnessMessages(text).length === 0;
}
