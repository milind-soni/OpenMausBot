// A loopback stand-in for Telegram's Bot API: getMe names the bot a token belongs to, getUpdates hands out the updates a
// test pushed (waiting a little when there are none, as the real one does), sendMessage records what was sent.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeTelegramSend { token: string; chatId: string; text: string }

export interface FakeTelegram {
  url: string;
  sent: FakeTelegramSend[];
  /** How many getUpdates calls each token made, and the last offset it asked with. */
  polls: Map<string, { count: number; offset?: number }>;
  /** A text message from `chatId` to the bot with this token. */
  push(token: string, chatId: number, text: string, extra?: { type?: string; name?: string }): number;
  /** Every send after this fails with Telegram's words, until `failSends(false)`. */
  failSends(on: boolean): void;
  close(): Promise<void>;
}

/** Only the given tokens are known; any other answers 401 as Telegram does. */
export async function startFakeTelegram(bots: Record<string, string>): Promise<FakeTelegram> {
  const sent: FakeTelegramSend[] = [];
  const polls = new Map<string, { count: number; offset?: number }>();
  const queues = new Map<string, Array<Record<string, unknown>>>();
  let nextUpdate = 1000;
  let sendsFail = false;
  const pending = async (token: string, offset: number | undefined, timeoutS: number) => {
    const deadline = Date.now() + Math.min(timeoutS, 2) * 1000;
    for (;;) {
      const updates = (queues.get(token) ?? []).filter((update) => offset === undefined || (update.update_id as number) >= offset);
      if (updates.length || Date.now() >= deadline) return updates;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      const answer = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
      if (!match) return answer(404, { ok: false, error_code: 404, description: "Not Found" });
      const [, token, method] = match;
      if (!(token! in bots)) return answer(401, { ok: false, error_code: 401, description: "Unauthorized" });
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      if (method === "getMe") return answer(200, { ok: true, result: { id: Number(token!.split(":")[0]), is_bot: true, first_name: bots[token!], username: bots[token!] } });
      if (method === "getUpdates") {
        const offset = typeof body.offset === "number" ? body.offset : undefined;
        polls.set(token!, { count: (polls.get(token!)?.count ?? 0) + 1, offset });
        return answer(200, { ok: true, result: await pending(token!, offset, typeof body.timeout === "number" ? body.timeout : 0) });
      }
      if (method === "sendMessage") {
        if (sendsFail) return answer(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
        if (typeof body.text !== "string" || body.text.length > 4096) return answer(400, { ok: false, error_code: 400, description: "Bad Request: message is too long" });
        sent.push({ token: token!, chatId: String(body.chat_id), text: body.text });
        return answer(200, { ok: true, result: { message_id: sent.length } });
      }
      return answer(404, { ok: false, error_code: 404, description: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sent,
    polls,
    push(token, chatId, text, extra = {}) {
      const update_id = nextUpdate++;
      const queue = queues.get(token) ?? [];
      queue.push({ update_id, message: { message_id: update_id, text, chat: { id: chatId, type: extra.type ?? "private" }, from: { first_name: extra.name ?? "Ada" } } });
      queues.set(token, queue);
      return update_id;
    },
    failSends(on) { sendsFail = on; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
