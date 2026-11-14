// The person's one-time answer before a bot uses their own computer, given the way the app gives it: find the open card in
// the conversation and answer it through the same route as the Allow once and Deny buttons.
import { YOUR_COMPUTER_TOOL } from "../../shared/your-computer.ts";

type Card = { requestId?: string; tool?: string; answered?: string; dismissed?: boolean; title?: string; subtitle?: string };

export async function openYourComputerCard(base: string, threadId: string, timeoutMs = 20_000): Promise<Card> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${base}/api/threads/${threadId}/messages?limit=200`);
    const body = await response.json().catch(() => ({})) as { messages?: Array<{ card?: Card }> };
    const card = body.messages?.map((message) => message.card).find((one) =>
      one?.tool === YOUR_COMPUTER_TOOL && one.requestId && !one.answered && !one.dismissed);
    if (card) return card;
    if (Date.now() >= end) throw new Error(`no open use-your-computer card in ${threadId}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

export async function answerYourComputer(base: string, threadId: string, behavior: "allow" | "deny" = "allow"): Promise<Card> {
  const card = await openYourComputerCard(base, threadId);
  const response = await fetch(`${base}/api/threads/${threadId}/respond`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: card.requestId, behavior }),
  });
  if (!response.ok) throw new Error(`answering the use-your-computer card failed: ${response.status} ${await response.text()}`);
  return card;
}

/** A first screen call and the person's answer to the question it raises, together. */
export async function withAnswer<T>(base: string, threadId: string, call: Promise<T>, behavior: "allow" | "deny" = "allow"): Promise<T> {
  const [value] = await Promise.all([call, answerYourComputer(base, threadId, behavior)]);
  return value;
}

/** After a test changes the app's driver record: desktop-parent.mjs polls it every 25 ms and hands the change over. */
export function appHandsItOver(ms = 200): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
