// Codex owns history; this receipt only remembers which bot rules it accepted.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Preserve native configured rules when overriding Codex's developer slot. */
export function codexDeveloperInstructions(config: unknown, botInstructions: string): string {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Codex returned no effective configuration; cannot safely update bot instructions.");
  }
  const configured = (config as Record<string, unknown>).developer_instructions;
  if (configured != null && typeof configured !== "string") {
    throw new Error("Codex returned invalid developer instructions; cannot safely update bot instructions.");
  }
  // Native rules previously outranked the bot's user-message prefix. Keep
  // them last in the combined developer block to preserve that precedence.
  return configured
    ? `${botInstructions || "No OpenMausBot bot-specific instructions remain."}\n\n${configured}`
    : botInstructions;
}

export async function syncCodexInstructions(
  key: string,
  nativeThreadId: string,
  instructions: string,
  resumed: boolean,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const directory = join(DATA_DIR, "codex-instructions");
  const path = join(directory, `${digest(JSON.stringify([key, nativeThreadId]))}.sha256`);
  const fingerprint = digest(instructions);
  let previous: string | undefined;
  try {
    previous = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (resumed && previous !== fingerprint) {
    // thread/resume config overrides are used after compaction, but Codex
    // 0.153.4 keeps the old initial developer message until then. Append a
    // developer update ONLY on change (or first adoption of an old session).
    // inject_items flushes native history before acknowledging; only then
    // persist our receipt. Unknown-method errors must fail, never lose rules.
    try {
      await request("thread/inject_items", {
        threadId: nativeThreadId,
        items: [{
          type: "message",
          role: "developer",
          content: [{
            type: "input_text",
            text: "The following replaces the previous developer instruction block supplied by OpenMausBot, including its native configured rules and bot-specific instructions. Other Codex instructions and permissions still apply.\n\n"
              + (instructions || "No OpenMausBot bot-specific instructions remain."),
          }],
        }],
      });
    } catch (error) {
      if (error instanceof Error && /method not found|unknown method/i.test(error.message)) {
        throw new Error(`This Codex version cannot update bot instructions in a resumed session. Update Codex and retry: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }
  if (!resumed || previous !== fingerprint) {
    mkdirSync(directory, { recursive: true });
    writeFileAtomic(path, fingerprint, { mode: 0o600 });
  }
}
