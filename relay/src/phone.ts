import type { WebSocket } from "ws";
import type { Context } from "./context.ts";
import { afterFirstMessage, closeWith, sendJson } from "./socket.ts";
import { Session } from "./splice.ts";
import { Close, parsePhoneHello, sha256 } from "./wire.ts";

/**
 * `GET /v1/phone`: a phone names a host and proves admission. An absent host and an unadmitted phone get the same 4404,
 * so a phone without a pairing cannot learn whether a computer is online.
 */
export function handlePhone(ctx: Context, ws: WebSocket): void {
  afterFirstMessage(ctx, ws, (message) => {
    const hello = parsePhoneHello(message);
    if (!hello) return void closeWith(ctx, ws, Close.Malformed);
    const admHash = sha256(hello.adm);
    const entry = ctx.hosts.get(hello.hidText);
    if (!ctx.hosts.admitted(entry, admHash) || !entry?.control) return void closeWith(ctx, ws, Close.NotFound);
    if (entry.sessions.size >= ctx.limits.hostSessionsMax || ctx.budgets.over(entry.hidText)) {
      return void closeWith(ctx, ws, Close.Limited);
    }
    const session = new Session(ctx, entry, admHash, ws);
    sendJson(entry.control, { t: "open", sid: session.sid });
    return (data, isBinary) => session.fromPhone(data, isBinary);
  });
}
