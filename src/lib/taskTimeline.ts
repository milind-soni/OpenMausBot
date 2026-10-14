import { failedTurnCause } from "../../shared/failed-turn.js";
import { redactSecretsInText } from "../../shared/redact.js";

export interface TimelineMessage {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "signin" | "routine.run" | "goal.run" | "digest" | "compaction" | "call" | "widget" | "app";
  text?: string;
  tool?: { name: string; summary?: string; ok?: boolean };
  png?: string;
  at: number;
}

export interface TimelineEvent {
  id: string;
  at: number;
  label: string;
  state: "running" | "complete" | "failed" | "observed";
  kind: "task" | "tool" | "screen" | "result";
  command?: string;
}

export function timelineEvents(messages: TimelineMessage[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let sawUserInput = false;
  for (const message of messages) {
    if (message.kind === "text" && message.role === "user" && message.text?.trim()) {
      events.push({
        id: message.id,
        at: message.at,
        label: sawUserInput ? "User input" : "Task started",
        state: "observed",
        kind: "task",
      });
      sawUserInput = true;
    } else if (message.kind === "activity" && message.tool) {
      const cause = failedTurnCause(message.tool.name);
      const failed = message.tool.ok === false || cause !== null;
      events.push({
        id: message.id,
        at: message.at,
        label: redactSecretsInText(cause ?? message.tool.name),
        ...(message.tool.summary ? { command: redactSecretsInText(message.tool.summary) } : {}),
        state: failed ? "failed" : message.tool.ok === true ? "complete" : "running",
        kind: "tool",
      });
    } else if (message.kind === "screen") {
      events.push({ id: message.id, at: message.at, label: "Screen observed", state: "observed", kind: "screen" });
    } else if (message.kind === "text" && message.role === "bot" && message.text?.trim()) {
      events.push({ id: message.id, at: message.at, label: "Response recorded", state: "complete", kind: "result" });
    }
  }
  return events;
}

/** Only the displayed activity, never chat text or raw provider data; scrubs again for older messages. */
export function runLogText(events: TimelineEvent[]): string {
  return redactSecretsInText(events.map((event) =>
    `[${new Date(event.at).toISOString()}] ${event.state} · ${event.label}${event.command ? `\n  ${event.command}` : ""}`,
  ).join("\n"));
}
