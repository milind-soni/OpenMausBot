import { randomUUID } from "node:crypto";
import type { ConnectorCall } from "../shared/outbound.ts";
import { describeTool } from "./activity.ts";

export type OutboundAnswer = "allow" | "deny" | "timeout";

interface Held {
  botId: string;
  threadId: string;
  tool: string;
  settle: (answer: OutboundAnswer) => void;
  answered?: OutboundAnswer;
  timer: ReturnType<typeof setTimeout>;
}

export type OutboundResolution =
  | { claimed: false }
  | { claimed: true; state: "allowed" | "denied" }
  | { claimed: true; state: "already_settled"; behavior: OutboundAnswer };

export class OutboundRequestService {
  private held = new Map<string, Held>();

  open(input: { botId: string; threadId: string; tool: string; timeoutMs: number }): {
    requestId: string;
    answer: Promise<OutboundAnswer>;
  } {
    const requestId = randomUUID();
    let settle!: (answer: OutboundAnswer) => void;
    const answer = new Promise<OutboundAnswer>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => this.settle(requestId, "timeout"), input.timeoutMs);
    timer.unref?.();
    this.held.set(requestId, { botId: input.botId, threadId: input.threadId, tool: input.tool, settle, timer });
    return { requestId, answer };
  }

  private settle(requestId: string, answer: OutboundAnswer): void {
    const entry = this.held.get(requestId);
    if (!entry || entry.answered) return;
    entry.answered = answer;
    clearTimeout(entry.timer);
    entry.settle(answer);
  }

  resolve(input: { threadId: string; requestId: string; behavior: "allow" | "deny" | "answer" }): OutboundResolution {
    const entry = this.held.get(input.requestId);
    if (!entry || entry.threadId !== input.threadId) return { claimed: false };
    if (entry.answered) return { claimed: true, state: "already_settled", behavior: entry.answered };
    const answer: OutboundAnswer = input.behavior === "allow" ? "allow" : "deny";
    this.settle(input.requestId, answer);
    return { claimed: true, state: answer === "allow" ? "allowed" : "denied" };
  }

  pending(threadId: string): string[] {
    return [...this.held.entries()]
      .filter(([, entry]) => entry.threadId === threadId && !entry.answered)
      .map(([requestId]) => requestId);
  }

  forget(requestId: string): void {
    const entry = this.held.get(requestId);
    if (entry) clearTimeout(entry.timer);
    this.held.delete(requestId);
  }
}

/** One app action on a card, with the files of this computer it will upload (server/connector-files.ts). */
export type CardCall = ConnectorCall & { files?: ReadonlyArray<{ name: string; path: string; bytes: number }> };

function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What a "Send on your behalf?" card shows: each app action, the files it uploads in full, and its arguments cut at 400
 * characters. The files come first so no argument can push one out of sight. */
export function outboundCard(outboundCalls: CardCall[]): { app: string | null; calls: { app: string | null; label: string }[]; summary: string } {
  const calls = outboundCalls.map((call) => {
    const { app, label } = describeTool(call.slug);
    return { app, label };
  });
  const summary = outboundCalls.map((call, index) => {
    const described = calls[index];
    const files = call.files?.length ? `\nUploads ${call.files.map((file) => `${file.name} (${file.path}, ${fileSize(file.bytes)})`).join("; ")}` : "";
    const argsText = call.arguments === undefined ? "" : JSON.stringify(call.arguments);
    return `${described.app ? `${described.app} · ` : ""}${described.label}${files}${argsText ? `\n${argsText.slice(0, 400)}${argsText.length > 400 ? "… [arguments truncated]" : ""}` : ""}`;
  }).join("\n\n");
  return { app: calls[0]?.app ?? null, calls, summary };
}
