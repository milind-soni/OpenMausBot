// Redacted before it is cut: a key sliced in half would slip past the shapes redaction knows.
import { MAX_QUESTION_TEXT } from "../shared/ask-question.ts";
import { HELD_SECRET_MASK, redactSecrets, redactSecretsInText } from "./redact.ts";

export function toolDetailPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let budget = 200;
  let textBudget = 256_000;
  const bounded = (item: unknown, depth = 0): unknown => {
    if (--budget < 0 || depth > 6) return "[additional data omitted]";
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
      result[key] = /token|secret|password|passwd|cookie|authorization|api.?key|(^|[_.-])keys?$/i.test(key)
        ? "[redacted]"
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
