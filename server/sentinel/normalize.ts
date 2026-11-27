// Privacy invariant: the hashed signature is the only form of a failure that may ever leave the machine; the
// normalized title stays local because it can still hold a name the person typed.
import { createHash } from "node:crypto";

import type { Origin } from "./types.ts";

const MAX_TEXT = 240;

export function normalizeSignatureText(text: string): string {
  return text
    // quoted values: "a.txt", 'Acme', `cmd` — not the apostrophe in "can't"
    .replace(/"[^"\n]*"|(?<![\w])'[^'\n]*'(?![\w])|`[^`\n]*`/g, "<q>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "<email>")
    .replace(/\b[A-Za-z]:\\[^\s:]+/g, "<path>")
    .replace(/(?:~|\.{1,2})?(?:\/[^\s/:'",)]+)+\/?/g, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    // hex ids and prefixed ids (tu-123-4, bx_9f2c…): letters and digits mixed
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b[a-z]{1,6}[_-](?=[\w-]*\d)[\w-]{4,}\b/gi, "<id>")
    .replace(/\b\d+(?:[.,:]\d+)*\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

const MAX_TITLE = 160;

export function capTitle(title: string): string {
  return title.slice(0, MAX_TITLE);
}

// Shell output names the files of the work in hand, so a failed command groups by error class and exit code.
const SHELL_ERROR_CLASSES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\btimed?[ -]?out\b|\btimeout\b/i, "timed out"],
  [/command not found|is not recognized as an internal or external command/i, "command not found"],
  [/syntax error|unexpected token|unexpected EOF|parse error/i, "syntax error"],
  [/no such file or directory|\bENOENT\b|cannot find the path/i, "no such file"],
  [/permission denied|\bEACCES\b/i, "permission denied"],
  [/operation not permitted|\bEPERM\b/i, "operation not permitted"],
  [/connection refused|could not resolve host|network is unreachable|\bECONNREFUSED\b|\bENOTFOUND\b/i, "network error"],
  [/out of memory|cannot allocate memory|\bENOMEM\b/i, "out of memory"],
  [/\bkilled\b|\bSIGKILL\b|\bSIGTERM\b|terminated by signal/i, "killed"],
  [/user (?:rejected|denied|doesn't want)|was denied|not allowed/i, "denied"],
];
const EXIT_CODE = /\bexit(?:ed with)?(?: code| status)?\s*[:=]?\s*(-?\d+)/i;

export function failureKey(tool: string, text: string): { key: string; title: string } {
  if (toolOrigin(tool) === "shell") {
    const errorClass = SHELL_ERROR_CLASSES.find(([pattern]) => pattern.test(text))?.[1];
    // a timeout's exit code is whichever signal stopped it
    const code = errorClass === "timed out" ? undefined : EXIT_CODE.exec(text)?.[1];
    const title = [code !== undefined ? `exit ${code}` : null, errorClass ?? (code === undefined ? "failed" : null)].filter(Boolean).join(": ");
    return { key: `${code ?? ""}\n${errorClass ?? ""}`, title: capTitle(title) };
  }
  const normalized = normalizeSignatureText(text);
  return { key: normalized, title: capTitle(normalized) || "failed" };
}

export function signatureOf(kind: string, ...parts: Array<string | undefined>): string {
  const hash = createHash("sha256").update(parts.map((part) => part ?? "").join("\n")).digest("hex");
  return `${kind}:${hash.slice(0, 16)}`;
}

// Reserved: people cannot name their own MCP servers after these.
const HARNESS_SERVERS = new Set([
  "ogb", "computer", "agents", "composio", "data", "browser", "phone", "dweb",
  "openmausbot", "openmausbot_connectors", "openmausbot_phone",
]);
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "exec_command", "local_shell", "run_command", "terminal"]);

export function toolOrigin(tool: string): Origin {
  if (tool === HARNESS_NOTICE) return "harness";
  const mcp = /^mcp__(.+?)__/.exec(tool);
  if (mcp) return HARNESS_SERVERS.has(mcp[1]!) ? "harness" : "external";
  return SHELL_TOOLS.has(tool.toLowerCase()) ? "shell" : "external";
}

export const HARNESS_NOTICE = "harness_notice";

/** Anything but one word is a sentence the harness wrote, which can carry a bot's name and is never kept as the tool. */
export function isToolIdentifier(name: string): boolean {
  return /^[\w.:/-]{1,128}$/.test(name);
}
