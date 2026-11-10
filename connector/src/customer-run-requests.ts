// The Admin's requests on a customer-run server. None reaches the home: the connector answers the four listed in
// customer-run.ts from facts it already reports, and refuses the rest. Each one, answered or refused, is a line in the
// audit log.
import type { Duplex } from "node:stream";

import type { AuditEvent } from "./audit.ts";
import { answerCustomerRunRequest, customerRunRequest, type ServerFacts } from "./customer-run.ts";
import { RequestGate, type RequestHead } from "./home-requests.ts";

const WORDS: Record<number, string> = { 200: "OK", 400: "Bad Request", 403: "Forbidden", 503: "Service Unavailable" };

function response(status: number, body: Record<string, unknown>): string {
  const text = JSON.stringify(body);
  return `HTTP/1.1 ${status} ${WORDS[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`;
}

export interface CustomerRunRequestOptions {
  facts: () => Promise<ServerFacts>;
  paused: () => boolean;
  record: (event: AuditEvent) => void;
}

export function serveCustomerRunRequest(stream: Duplex, accept: () => void, options: CustomerRunRequestOptions): void {
  let answered = false;
  const answer = (head: RequestHead | null, status: number, body: Record<string, unknown>, refused?: "mode" | "paused") => {
    if (answered) return;
    answered = true;
    options.record({ event: "request", by: "admin", method: head?.method ?? "INVALID", path: head?.target.split("?")[0]!.slice(0, 200) ?? "", status, ...(refused ? { refused } : {}) });
    if (!stream.destroyed) stream.end(response(status, body));
  };
  const gate = new RequestGate((head) => {
    if (options.paused()) return answer(head, 403, { error: "paused" }, "paused");
    const request = head.length === 0 ? customerRunRequest(head.method, head.target) : null;
    if (!request) return answer(head, 403, { error: "refused_by_mode" }, "mode");
    options.facts().then(
      (facts) => answer(head, 200, answerCustomerRunRequest(request, facts)),
      () => answer(head, 503, { error: "unavailable" }),
    );
  }, () => {});
  gate.on("error", () => answer(null, 400, { error: "invalid_request" }, "mode"));
  gate.resume();
  accept();
  stream.pipe(gate);
}
