// MCP elicitation through Claude Code's stream-json control protocol (2.1.317). When an MCP server asks the
// person something during a tool call, the CLI writes {type:"control_request", request:{subtype:"elicitation"}}
// and waits for a control_response on stdin; a control_cancel_request withdraws the question (the server gave up).
// Unanswered, the tool call failed "No response to elicitation prompt within the allowed time". A plain confirmation
// becomes an approval card; a form with fields or a link to open is declined at once with a note in the chat.
import type { RuntimeEvent } from "../../shared/runtime-events.ts";

type Body<T> = T extends unknown ? Omit<T, "threadId" | "turnId" | "provider" | "providerInstanceId" | "createdAt" | "eventId"> : never;
type ElicitationEvent = Body<Extract<RuntimeEvent, { type: "request.opened" | "request.resolved" | "runtime.notice" }>>;

const CARD_PREFIX = "elicitation:";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** `write` settles true once the frame reached the CLI's stdin, false when it could not be sent. */
export function claudeElicitations(write: (frame: unknown) => Promise<boolean>, emit: (event: ElicitationEvent) => void) {
  const pending = new Set<string>();
  // Answers still being written to the CLI; true once the card was withdrawn meanwhile.
  const sending = new Map<string, boolean>();
  const reply = (id: string, response: Record<string, unknown>) =>
    write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  const resolved = (id: string, behavior: "allow" | "deny", source: "user" | "timeout" | "system") =>
    emit({ type: "request.resolved", requestId: CARD_PREFIX + id, behavior, source });
  return {
    /** Consumes an elicitation frame or its withdrawal; false for every other frame. */
    frame(o: any): boolean {
      if (o?.type === "control_cancel_request") {
        if (typeof o.request_id !== "string") return false;
        if (sending.has(o.request_id)) {
          if (!sending.get(o.request_id)) resolved(o.request_id, "deny", "timeout");
          sending.set(o.request_id, true);
          return true;
        }
        if (!pending.delete(o.request_id)) return false;
        resolved(o.request_id, "deny", "timeout");
        return true;
      }
      if (o?.type !== "control_request" || o.request?.subtype !== "elicitation" || typeof o.request_id !== "string") return false;
      const id: string = o.request_id;
      const r = o.request;
      const serverName = text(r.mcp_server_name);
      const server = text(r.display_name) || serverName || "An MCP server";
      const message = text(r.message);
      const properties = r.requested_schema?.properties;
      const required = r.requested_schema?.required;
      // A required name with no declared property still needs a value the card can't collect.
      const fields = new Set([
        ...(properties && typeof properties === "object" ? Object.keys(properties) : []),
        ...(Array.isArray(required) ? required.filter((name: unknown) => typeof name === "string") : []),
      ]).size;
      if (r.mode === "url" || fields > 0) {
        void reply(id, { action: "decline" });
        const url = text(r.url);
        emit({
          type: "runtime.notice",
          message: r.mode === "url"
            ? `${server} asked you to open a link to continue${/^https:\/\//i.test(url) ? `: ${url}` : ""}. OpenMausBot can't open it from here, so the request was declined. Open the link yourself, then ask the bot to try again.`
            : `${server} asked you to fill in ${fields === 1 ? "a field" : `${fields} fields`}${message ? ` ("${message}")` : ""}. OpenMausBot can't show that form yet, so the request was declined.`,
        });
        return true;
      }
      pending.add(id);
      emit({
        type: "request.opened",
        requestId: CARD_PREFIX + id,
        requestType: "permission",
        tool: serverName ? `mcp__${serverName}` : "mcp",
        summary: message ? `${server}: ${message}` : `${server} asks to continue`,
        // The server asks, not a tool: Auto mode and remembered tool grants never answer it.
        requiresExplicitApproval: true,
      });
      return true;
    },
    /**
     * The person's answer to one of these cards: "sent" once the CLI has it, "failed" when it could not be
     * delivered (the card is withdrawn, never shown as approved), false when the card is not an open elicitation.
     */
    async answer(requestId: string, behavior: "allow" | "deny" | "answer"): Promise<"sent" | "failed" | false> {
      const id = requestId.startsWith(CARD_PREFIX) ? requestId.slice(CARD_PREFIX.length) : "";
      if (!pending.delete(id)) return false;
      sending.set(id, false);
      const delivered = await reply(id, behavior === "allow" ? { action: "accept", content: {} } : { action: "decline" });
      const cancelled = sending.get(id);
      sending.delete(id);
      // The card was withdrawn (CLI cancelled, session closed) while the answer was on its way: it never counts.
      if (cancelled) return "failed";
      if (!delivered) {
        resolved(id, "deny", "system");
        return "failed";
      }
      resolved(id, behavior === "allow" ? "allow" : "deny", "user");
      return "sent";
    },
    /** The CLI that asked is gone: every open card is withdrawn. */
    close(): void {
      for (const id of pending) resolved(id, "deny", "system");
      pending.clear();
      // Answers still on their way are withdrawn now too; answer() then reports them as failed.
      for (const [id, withdrawn] of sending) {
        if (withdrawn) continue;
        resolved(id, "deny", "system");
        sending.set(id, true);
      }
    },
  };
}
