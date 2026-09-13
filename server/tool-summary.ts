// What a tool call is about to do, in words a chip or a permission card can
// show. Redacted before it is cut: a command line is where credentials get
// pasted, and a key sliced in half would slip past the shapes redaction knows.
import { redactSecrets, redactSecretsInText } from "./redact.ts";

/** Display-only excerpt, never the raw protocol payload. Bound traversal and
 * omit binary bodies before redacting; truncate only AFTER redaction so a
 * credential cannot be cut in half and escape detection. */
export function toolDetailPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let budget = 200;
  let textBudget = 256_000;
  const bounded = (item: unknown, depth = 0): unknown => {
    if (--budget < 0 || depth > 6) return "[additional data omitted]";
    if (typeof item === "string") {
      if (item.length > textBudget) return "[large content omitted]";
      if (/^data:[^,\s]+;base64,/i.test(item)) return "[binary content omitted]";
      // MCP frequently puts JSON inside text content. Recover its field
      // names so short credentials get the same masking as native objects.
      if (/^\s*[[{]/.test(item)) {
        try { return bounded(JSON.parse(item), depth + 1); }
        catch { /* ordinary text/code: use the content redactor below */ }
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

const QUESTION_LIMIT = 300;
const LIMIT = 200;

function fieldsOf(input: unknown): Record<string, unknown> | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

const cut = (text: string, limit: number) => redactSecretsInText(text).trim().slice(0, limit);

/** The shell command a tool call runs, on one redacted line of at most 200
 * characters — what rides beside the tool name on the chip and what the
 * Verify card reads as a step. Only a command: a Read's path or a fetch's
 * URL is not something the bot ran, so those calls carry no summary. */
export function commandSummary(input: unknown): string | undefined {
  const command = fieldsOf(input)?.command;
  if (typeof command !== "string") return undefined;
  return cut(command.replace(/\s*[\r\n]+\s*/g, " "), LIMIT);
}

/** The permission card's subtitle: the question asked, else the command as
 * the bot wrote it (newlines kept — a multi-line command reads on the card
 * the way it will run), else the URL, else the arguments as JSON. Undefined
 * when there is nothing to say (no input, or an empty object). */
export function askInputSummary(input: unknown): string | undefined {
  const fields = fieldsOf(input);
  if (!fields) return undefined;
  if (typeof fields.question === "string") return cut(fields.question, QUESTION_LIMIT);
  if (typeof fields.command === "string") return cut(fields.command, LIMIT);
  if (typeof fields.url === "string") return cut(fields.url, LIMIT);
  const text = JSON.stringify(fields);
  return text === "{}" ? undefined : cut(text, LIMIT);
}
