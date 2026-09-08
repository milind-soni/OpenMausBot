/**
 * Utilities for analyzing text metrics and estimating LLM token counts in real time.
 * Calibrated against modern BPE tokenizers (GPT-4, Claude 3.5, Gemini) without external runtime dependencies.
 */

/** Text metrics breakdown containing word, character, and estimated token counts. */
export interface TextMetrics {
  /** Total number of whitespace-delimited words. */
  words: number;
  /** Total number of raw characters in the string. */
  characters: number;
  /** Estimated token count based on modern BPE tokenization heuristics. */
  estimatedTokens: number;
}

/** Regular expression to detect CJK (Chinese, Japanese, Korean) characters. */
const CJK_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * Counts the number of words in a text string.
 *
 * @param text - Input text string.
 * @returns Number of words (0 for empty or whitespace-only strings).
 *
 * @example
 * ```ts
 * countWords("Hello world"); // 2
 * countWords("");            // 0
 * ```
 */
export function countWords(text?: string | null): number {
  if (!text || !text.trim()) {
    return 0;
  }
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/**
 * Estimates the number of tokens an LLM tokenizer will produce for a given text.
 * Uses a calibrated BPE heuristic accounting for English words, digits, punctuation, and CJK characters.
 *
 * @param text - Input text string.
 * @returns Estimated token count (0 for empty or whitespace-only strings, >= 1 otherwise).
 *
 * @example
 * ```ts
 * estimateTokens("Hello world"); // 2
 * estimateTokens("const x = [1, 2, 3];"); // ~11
 * ```
 */
export function estimateTokens(text?: string | null): number {
  if (!text || !text.trim()) {
    return 0;
  }

  // 1. Extract and count CJK characters (average ~1.3 tokens per character)
  const cjkMatches = text.match(CJK_REGEX) || [];
  const nonCjkText = text.replace(CJK_REGEX, " ");

  // 2. Tokenize alphabetical words, numeric sequences, and punctuation/symbols
  const words = nonCjkText.match(/\p{L}+/gu) || [];
  const numbers = nonCjkText.match(/\p{N}+/gu) || [];
  const symbols = nonCjkText.match(/[^\s\p{L}\p{N}]/gu) || [];

  let tokenCount = 0;

  // Common short words (<= 5 chars) generally map to 1 token in BPE; longer words split
  for (const word of words) {
    tokenCount += word.length <= 5 ? 1 : Math.ceil(word.length / 4);
  }

  // Numbers tokenize roughly 1 token per 3 digits
  for (const num of numbers) {
    tokenCount += Math.ceil(num.length / 3);
  }

  // Individual punctuation, symbols, and operators almost always constitute distinct tokens
  tokenCount += symbols.length;

  // CJK characters average ~1.3 tokens per character
  tokenCount += Math.ceil(cjkMatches.length * 1.3);

  return Math.max(1, tokenCount);
}

/**
 * Computes complete text metrics including word, character, and estimated token counts.
 *
 * @param text - Input text string.
 * @returns Complete {@link TextMetrics} object.
 *
 * @example
 * ```ts
 * const metrics = getTextMetrics("Hello world");
 * // { words: 2, characters: 11, estimatedTokens: 2 }
 * ```
 */
export function getTextMetrics(text?: string | null): TextMetrics {
  if (!text || !text.trim()) {
    return {
      words: 0,
      characters: 0,
      estimatedTokens: 0,
    };
  }

  return {
    words: countWords(text),
    characters: text.length,
    estimatedTokens: estimateTokens(text),
  };
}

/**
 * Formats a token count into a compact, human-readable string.
 *
 * @param tokens - Number of tokens.
 * @returns Formatted string (e.g. "~42 tok", "~1.5k tok", "~24k tok").
 *
 * @example
 * ```ts
 * formatTokenCount(42);   // "~42 tok"
 * formatTokenCount(1500); // "~1.5k tok"
 * ```
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return `~${tokens} tok`;
  }
  if (tokens < 10_000) {
    const k = (tokens / 1000).toFixed(1);
    return `~${k.endsWith(".0") ? k.slice(0, -2) : k}k tok`;
  }
  return `~${Math.round(tokens / 1000)}k tok`;
}

/**
 * Formats a word count into a human-readable string with proper singular/plural grammar.
 *
 * @param words - Number of words.
 * @returns Formatted label (e.g. "1 word", "42 words").
 *
 * @example
 * ```ts
 * formatWordCount(1);  // "1 word"
 * formatWordCount(42); // "42 words"
 * ```
 */
export function formatWordCount(words: number): string {
  return words === 1 ? "1 word" : `${words.toLocaleString()} words`;
}
