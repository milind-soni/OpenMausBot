import { nameIsCommand } from "../../shared/tool-name";

/** 124 is `timeout`'s status; 137 and 143 are SIGKILL and SIGTERM, which is how a timed-out Bash call ends. */
const STOPPED = new Set([124, 137, 143]);

const EXIT_LINE = /^\s*Exit code (\d+)[^\S\r\n]*(?:\r?\n|$)/;

/** Some providers send content blocks, which the server previews as JSON. */
function resultText(output: string): string {
  if (!/^\s*[[{]/.test(output)) return output;
  try {
    const parsed: unknown = JSON.parse(output);
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    const texts = blocks.map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : null));
    return texts.every((text) => text !== null) ? texts.join("\n") : output;
  } catch {
    return output;
  }
}

/** Claude Code's Bash tool marks any non-zero exit `is_error` and starts the result with `Exit code N`, even
 * when every command but the last did its job. Null keeps the call a failure. */
export function softExitCode(tool: { name: string; ok?: boolean; output?: string }): number | null {
  if (tool.ok !== false || !tool.output) return null;
  if (tool.name !== "Bash" && !nameIsCommand(tool.name)) return null;
  const text = resultText(tool.output);
  const match = EXIT_LINE.exec(text);
  if (!match) return null;
  const code = Number(match[1]);
  if (!code || STOPPED.has(code)) return null;
  const rest = text.slice(match[0].length);
  if (/timed out|\bkilled\b/i.test(rest)) return null;
  const lines = rest.split(/\r?\n/).filter((line) => line.trim()).length;
  return lines >= 2 || rest.trim().length >= 120 ? code : null;
}
