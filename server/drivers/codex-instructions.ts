// Codex owns history; this receipt only remembers which bot rules and which
// volatile context digest the native thread last carried.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Receipts written before the volatile split hold the bare instruction
 * fingerprint, as do ones still waiting for their turn to be accepted;
 * committed ones are JSON with both digests. Anything unreadable reads as
 * unknown, which re-delivers once and rewrites the file. */
export interface CodexInstructionReceipt {
  instructions: string;
  volatile?: string;
}

const isFingerprint = (value: string) => /^[0-9a-f]{64}$/.test(value);

function parseReceipt(raw: string | undefined): CodexInstructionReceipt | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (isFingerprint(trimmed)) return { instructions: trimmed };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { instructions?: unknown; volatile?: unknown };
      if (typeof record.instructions === "string" && isFingerprint(record.instructions)) {
        return {
          instructions: record.instructions,
          ...(typeof record.volatile === "string" && isFingerprint(record.volatile) ? { volatile: record.volatile } : {}),
        };
      }
    }
  } catch {
    /* a corrupt receipt is simply unknown */
  }
  return null;
}

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
  volatile: string,
  resumed: boolean,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  mentionTurn = false,
): Promise<{ deliverVolatile: boolean; hadVolatile: boolean; commitVolatile: (() => void) | null }> {
  const directory = join(DATA_DIR, "codex-instructions");
  const path = join(directory, `${digest(JSON.stringify([key, nativeThreadId]))}.sha256`);
  const fingerprint = digest(instructions);
  const volatileFingerprint = digest(volatile);
  let previous: CodexInstructionReceipt | null;
  try {
    previous = parseReceipt(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    previous = null;
  }
  if (resumed && previous?.instructions !== fingerprint) {
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
  // A mention describes the turn it rides: deliver it on every tagged turn,
  // even when the volatile text is byte-identical to the previous turn's.
  const deliverVolatile = !resumed || previous?.volatile !== volatileFingerprint || mentionTurn;
  const hadVolatile = typeof previous?.volatile === "string" && previous.volatile !== digest("");
  if (!resumed || previous?.instructions !== fingerprint) {
    // Instructions-only, and only after inject_items acknowledged: the
    // volatile digest stays pending until the driver commits it after the
    // provider accepts the turn, so a submission the provider rejected
    // redelivers its context on the next attempt.
    mkdirSync(directory, { recursive: true });
    writeFileAtomic(path, JSON.stringify({ instructions: fingerprint }), { mode: 0o600 });
  }
  const commitVolatile = previous?.instructions === fingerprint && previous?.volatile === volatileFingerprint
    ? null
    : () => {
        mkdirSync(directory, { recursive: true });
        writeFileAtomic(path, JSON.stringify({ instructions: fingerprint, volatile: volatileFingerprint }), { mode: 0o600 });
      };
  return { deliverVolatile, hadVolatile, commitVolatile };
}
