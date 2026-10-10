export const MAX_TOOL_ERROR_CORRECTIVE_ROUNDS = 5;
export const TOOL_ERROR_CORRECTIVE_ROUNDS_INPUT_ERROR = "Enter a whole number from 0 to 5.";

export type ToolErrorCorrectiveRoundsInput =
  | { ok: true; rounds: number }
  | { ok: false; error: string };

export function parseToolErrorCorrectiveRounds(value: string): ToolErrorCorrectiveRoundsInput {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: TOOL_ERROR_CORRECTIVE_ROUNDS_INPUT_ERROR };
  const rounds = Number(trimmed);
  if (rounds < 0 || rounds > MAX_TOOL_ERROR_CORRECTIVE_ROUNDS) {
    return { ok: false, error: TOOL_ERROR_CORRECTIVE_ROUNDS_INPUT_ERROR };
  }
  return { ok: true, rounds };
}
