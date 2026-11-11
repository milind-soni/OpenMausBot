// `/burst <task>`: like /setup, a rewrite of this turn's text only; the transcript keeps what the person typed.
const BURST_COMMAND = /^\/burst(?:\s+|$)([\s\S]*)$/i;

export function parseBurstCommand(text: string): { request: string } | null {
  const match = BURST_COMMAND.exec(text.trim());
  return match ? { request: match[1]!.trim() } : null;
}

export function expandBurstTurnText(userText: string): string {
  const burst = parseBurstCommand(userText);
  if (!burst) return userText;
  return burst.request
    ? `The person used /burst for this request: ${burst.request}\n\nCall the burst tool now with it: their list as items when they gave one, otherwise split it into one item per independent part yourself. Do none of the work here.`
    : "The person used /burst without a request. Ask them, in one short line, what they want run in parallel.";
}
