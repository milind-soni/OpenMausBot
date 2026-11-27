// Redacted before it is cut: a key sliced in half would slip past the shapes redaction knows.
import { MAX_QUESTION_TEXT } from "../shared/ask-question.ts";
import { HELD_SECRET_MASK, redactSecrets, redactSecretsInText } from "./redact.ts";

export function toolDetailPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let budget = 200;
  let textBudget = 256_000;
  /** A failed call's error is the cause the model must read; it is kept whole even where the rest is omitted. */
  const ERROR_KEY = /^error/i;
  const SECRET_KEY = /token|secret|password|passwd|cookie|authorization|api.?key|(^|[_.-])keys?$/i;
  const secretKeysOut = (item: unknown, depth = 0): unknown => {
    if (depth > 12 || item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map((child) => secretKeysOut(child, depth + 1));
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, SECRET_KEY.test(key) ? "[redacted]" : secretKeysOut(child, depth + 1)]));
  };
  const ERROR_TEXT_MAX = 500;
  const errorText = (value: unknown): string => {
    let parsed = value;
    if (typeof value === "string" && /^\s*[[{]/.test(value)) {
      try { parsed = JSON.parse(value); }
      catch {}
    }
    let text: string;
    if (typeof parsed === "string") text = parsed;
    else {
      try { text = JSON.stringify(redactSecrets(secretKeysOut(parsed))) ?? ""; }
      catch { return "[error not serializable]"; }
    }
    // Redact before the cut, like commandSummary, so a sliced credential cannot slip through.
    return redactSecretsInText(text).trim().slice(0, ERROR_TEXT_MAX);
  };
  /** The first /^error/i value anywhere below an omitted object: the cause a failed call must still give up. */
  const findError = (item: Record<string, unknown> | object, depth = 0): unknown => {
    if (depth > 12) return undefined;
    const entries = Object.entries(item).slice(0, 40).filter(([key]) => !SECRET_KEY.test(key));
    for (const [key, child] of entries) {
      if (ERROR_KEY.test(key) && isErrorValue(child)) return child;
    }
    for (const [, child] of entries) {
      if (child !== null && typeof child === "object" && !Array.isArray(child)) {
        const found = findError(child, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const isErrorValue = (value: unknown) => typeof value === "string" || (value !== null && typeof value === "object");
  const bounded = (item: unknown, depth = 0): unknown => {
    if (--budget < 0 || depth > 6) {
      // Out of budget or depth, a payload carrying an error still gives up its cause instead of a bare placeholder.
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const error = findError(item);
        if (error !== undefined) return { error: errorText(error), "…": "[additional data omitted]" };
      }
      return "[additional data omitted]";
    }
    if (typeof item === "string") {
      if (item.length > textBudget) return "[large content omitted]";
      if (/^data:[^,\s]+;base64,/i.test(item)) return "[binary content omitted]";
      if (/^\s*[[{]/.test(item)) {
        try { return bounded(JSON.parse(item), depth + 1); }
        catch {}
      }
      textBudget -= item.length;
      return item;
    }
    if (typeof item === "bigint") return String(item);
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.slice(0, 40).map((child) => bounded(child, depth + 1)).concat(item.length > 40 ? ["[additional items omitted]"] : []);
    const entries = Object.entries(item);
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, child] of entries.slice(0, 40)) {
      result[key] = SECRET_KEY.test(key)
        ? "[redacted]"
        : ERROR_KEY.test(key) && isErrorValue(child)
        ? errorText(child)
        : /^(data|base64|blob)$/i.test(key) && typeof child === "string"
          ? "[binary content omitted]"
          : bounded(child, depth + 1);
    }
    if (entries.length > 40) result["…"] = "[additional fields omitted]";
    return result;
  };
  const safe = redactSecrets(bounded(value));
  const text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
  if (!text?.trim() || text === "{}" || text === "[]") return undefined;
  return text.length > 6_000 ? `${text.slice(0, 6_000)}\n[… preview shortened]` : text;
}

export const COMMAND_SUMMARY_MAX = 200;
const LIMIT = COMMAND_SUMMARY_MAX;

const NOT_SHOWN = /\[(?:redacted|(?:binary|large) content omitted|additional (?:data|items|fields) omitted|… preview shortened)\]|«redacted \d+ chars»/;

/** Two previews that read the same prove the same call only when neither masked, left out or cut a value. */
export function previewIsPartial(preview: string): boolean {
  return NOT_SHOWN.test(preview) || preview.includes(HELD_SECRET_MASK);
}

function fieldsOf(input: unknown): Record<string, unknown> | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

const cut = (text: string, limit: number) => redactSecretsInText(text).trim().slice(0, limit);

export function commandSummary(input: unknown): string | undefined {
  const command = fieldsOf(input)?.command;
  if (typeof command !== "string") return undefined;
  return cut(command.replace(/\s*[\r\n]+\s*/g, " "), LIMIT);
}

export function askInputSummary(input: unknown): string | undefined {
  const fields = fieldsOf(input);
  if (!fields) return undefined;
  if (typeof fields.question === "string") return cut(fields.question, MAX_QUESTION_TEXT);
  if (typeof fields.command === "string") return cut(fields.command, LIMIT);
  if (typeof fields.url === "string") return cut(fields.url, LIMIT);
  const text = JSON.stringify(fields);
  return text === "{}" ? undefined : cut(text, LIMIT);
}
