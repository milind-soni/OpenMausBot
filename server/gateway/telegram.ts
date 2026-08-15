// Telegram gateway — chat with your bots from your phone. A standalone
// process that rides the harness HTTP+SSE contract (no new transports in
// the app): it long-polls api.telegram.org, binds one Telegram chat to the
// Mac's owner, maps that chat onto one active bot at a time, folds the
// canonical runtime event stream into Telegram messages (streaming replies
// via throttled message edits), and turns permission/question asks into
// inline keyboards wired straight to /api/bots/:id/respond — approve from
// your phone.
//
//   TELEGRAM_BOT_TOKEN=123:abc pnpm gateway:telegram
//
// The token can also live in ~/.openmausbot/config.json as
// {"telegram": {"token": "…"}}. Gateway state (owner chat, active bot)
// persists in ~/.openmausbot/telegram-gateway.json. The FIRST chat that
// sends /start becomes the owner; every other chat is refused — this
// gateway can approve shell commands, so it is bound to one human.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";

const SERVER = process.env.OMB_SERVER_URL ?? "http://127.0.0.1:8799";
const STATE_PATH = join(DATA_DIR, "telegram-gateway.json");
const EDIT_THROTTLE_MS = 1500;
/** Telegram hard limit is 4096 chars per message. */
export const TELEGRAM_MAX = 4096;

// ── pure helpers (unit-tested) ─────────────────────────────────────────

/** Split text into Telegram-sized chunks, preferring newline boundaries. */
export function chunkText(text: string, max = TELEGRAM_MAX): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Exponential backoff with a ceiling: quick retries for a blip, patient
 * ones for an outage, never longer than a minute so recovery stays fast. */
export function backoffMs(failures: number, base = 2000, ceiling = 60_000): number {
  return Math.min(ceiling, base * 2 ** Math.min(failures - 1, 10));
}

/** `fetch` rejects with a bare "fetch failed" and hides the real reason in
 * `cause` — a gateway that only logs the message is undebuggable. */
export function describeError(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause ? `${err.message} (${cause})` : String(err?.message ?? e);
}

export interface AskEvent {
  requestId?: string;
  requestType: "permission" | "question";
  tool: string;
  summary: string;
  choices?: string[];
}

/** Inline keyboard for an ask. Permissions get Allow/Deny; questions get
 * one button per offered choice (free-text answers arrive as a reply). */
export function keyboardFor(ask: AskEvent): Array<Array<{ text: string; callback_data: string }>> {
  const id = ask.requestId ?? "";
  if (ask.requestType === "permission") {
    return [[
      { text: "✅ Allow", callback_data: `req:${id}:allow` },
      { text: "❌ Deny", callback_data: `req:${id}:deny` },
    ]];
  }
  const choices = (ask.choices ?? []).slice(0, 5);
  if (!choices.length) return [[{ text: "✍️ Answer in chat (reply to this)", callback_data: `req:${id}:prompt` }]];
  return choices.map((c, i) => [{ text: c.slice(0, 60), callback_data: `req:${id}:choice:${i}` }]);
}

/** One human-readable header line for an ask message. */
export function askHeader(botName: string, ask: AskEvent): string {
  const kind = ask.requestType === "permission" ? "wants to use" : "asks";
  return `🔐 ${botName} ${kind} ${ask.requestType === "permission" ? ask.tool : "you"}:\n${ask.summary}`;
}

// ── config + state ─────────────────────────────────────────────────────

function botToken(): string {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const cfg = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    if (typeof cfg?.telegram?.token === "string" && cfg.telegram.token) return cfg.telegram.token;
  } catch {
    /* no config file yet */
  }
  console.error("telegram gateway: no token — set TELEGRAM_BOT_TOKEN or add {\"telegram\":{\"token\":\"…\"}} to ~/.openmausbot/config.json");
  process.exit(1);
}

interface GatewayState {
  ownerChatId?: number;
  activeBotId?: string;
}

function loadState(): GatewayState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s: GatewayState) {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    // a silent failure here is a security hole, not an inconvenience: the
    // owner binding would not survive a restart, and the next chat to send
    // /start could claim a gateway that approves shell commands
    console.error(`telegram gateway: CANNOT PERSIST STATE to ${STATE_PATH} — the owner binding will not survive a restart: ${describeError(e)}`);
  }
}

// ── harness API ────────────────────────────────────────────────────────

interface Bot {
  id: string;
  threadId: string;
  name: string;
  busy?: boolean;
  modelSelection: { instanceId: string; model: string };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text().catch(() => "")}`.trim());
  return (await res.json()) as T;
}

const listBots = async () => (await api<{ bots: Bot[] }>("/api/bots")).bots;

// ── telegram API (zero-dependency long polling) ────────────────────────

function telegram(token: string) {
  const base = `https://api.telegram.org/bot${token}`;
  const call = async (method: string, payload: Record<string, unknown>) => {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: any; description?: string };
    if (!body.ok) throw new Error(`telegram ${method}: ${body.description ?? res.status}`);
    return body.result;
  };
  return {
    send: (chatId: number, text: string, keyboard?: unknown): Promise<{ message_id: number }> =>
      call("sendMessage", {
        chat_id: chatId,
        text,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      }),
    edit: (chatId: number, messageId: number, text: string) =>
      call("editMessageText", { chat_id: chatId, message_id: messageId, text }).catch(() => {}),
    clearKeyboard: (chatId: number, messageId: number) =>
      call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {}),
    answerCallback: (id: string, text?: string) => call("answerCallbackQuery", { callback_query_id: id, text }).catch(() => {}),
    updates: (offset: number) => call("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] }),
  };
}

// ── the gateway loop ───────────────────────────────────────────────────

async function main() {
  const tg = telegram(botToken());
  const state = loadState();

  // streaming reply state for the active bot's thread: one Telegram
  // message that grows by throttled edits until the turn settles
  let stream: { messageId: number; text: string; lastEdit: number; timer?: ReturnType<typeof setTimeout> } | null = null;
  // requestId → the ask's Telegram message (to clear its keyboard) + shape
  const asks = new Map<string, { messageId: number; ask: AskEvent; botId: string }>();
  // question asks answered by a text reply instead of a button
  let promptingAsk: string | null = null;

  const owner = () => state.ownerChatId;

  // threadId → bot lookups happen once per runtime event, and deltas
  // arrive per token — so the roster is cached and only re-fetched when a
  // thread is unknown (a bot created since the last refresh).
  let botCache: Bot[] = [];
  const refreshBots = async () => {
    botCache = await listBots();
    return botCache;
  };
  const botForThread = async (threadId: string): Promise<Bot | undefined> => {
    const hit = botCache.find((b) => b.threadId === threadId);
    if (hit) return hit;
    return (await refreshBots()).find((b) => b.threadId === threadId);
  };

  /** The bot the owner is talking to. A stored id that no longer resolves
   * (deleted bot) is REPAIRED here — leaving it dangling would make every
   * `isActive` check false and silently drop the whole reply stream. */
  const activeBot = async (): Promise<Bot | null> => {
    const bots = await refreshBots();
    const chosen = bots.find((b) => b.id === state.activeBotId) ?? bots[0] ?? null;
    if (chosen && state.activeBotId !== chosen.id) {
      state.activeBotId = chosen.id;
      saveState(state);
    }
    return chosen;
  };

  const botKeyboard = (bots: Bot[]) =>
    bots.map((b) => [{ text: `${b.busy ? "⏳ " : ""}${b.name}`, callback_data: `bot:${b.id}` }]);

  /** Settle the streaming bubble: the bubble holds the FIRST chunk (it is
   * the message that has been growing), any remainder goes out as further
   * messages, in order. Awaited by every caller so bubbles can never
   * overtake each other. */
  const flushStream = async (chatId: number) => {
    if (!stream) return;
    const s = stream;
    if (s.timer) clearTimeout(s.timer);
    s.timer = undefined;
    s.lastEdit = Date.now();
    const [head, ...rest] = chunkText(s.text);
    await tg.edit(chatId, s.messageId, head ?? "…");
    for (const part of rest) await tg.send(chatId, part);
    stream = null;
  };

  const onDelta = async (chatId: number, delta: string) => {
    if (!stream) {
      const sent = await tg.send(chatId, delta.trim() || "…");
      stream = { messageId: sent.message_id, text: delta, lastEdit: Date.now() };
      return;
    }
    stream.text += delta;
    // Telegram edits are rate-limited — batch deltas on a timer. When the
    // text outgrows one message, settle the full chunks and keep only the
    // tail growing: re-joining the remainder would rebuild a body over the
    // 4096 limit, which Telegram rejects and every later edit repeats.
    if (stream.text.length > TELEGRAM_MAX) {
      const [head, ...rest] = chunkText(stream.text);
      const tail = rest.pop() ?? "";
      if (stream.timer) clearTimeout(stream.timer);
      await tg.edit(chatId, stream.messageId, head);
      for (const part of rest) await tg.send(chatId, part);
      const sent = await tg.send(chatId, tail || "…");
      stream = { messageId: sent.message_id, text: tail, lastEdit: Date.now() };
      return;
    }
    if (!stream.timer) {
      const due = Math.max(0, EDIT_THROTTLE_MS - (Date.now() - stream.lastEdit));
      stream.timer = setTimeout(() => void flushStream(chatId), due);
      stream.timer.unref?.();
    }
  };

  // ── SSE: fold runtime events into the chat ───────────────────────────
  const consumeEvents = async () => {
    let failures = 0;
    for (;;) {
      try {
        const res = await fetch(`${SERVER}/api/events`);
        if (!res.body) throw new Error("no body");
        console.log(`telegram gateway: event stream connected${failures ? ` (after ${failures} failed attempt(s))` : ""}`);
        failures = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (!data) continue;
            let payload: any;
            try {
              payload = JSON.parse(data);
            } catch {
              continue;
            }
            await handleBroadcast(payload).catch((e) => console.error("gateway handle:", describeError(e)));
          }
        }
        // the stream ended without throwing — the harness restarted or
        // dropped us; that is a failed attempt too, so the backoff grows
        failures += 1;
      } catch (e) {
        failures += 1;
        if (failures <= 3 || failures % 10 === 0) {
          console.error(`gateway SSE (attempt ${failures}): ${describeError(e)}`);
        }
      }
      stream = null;
      await new Promise((r) => setTimeout(r, backoffMs(failures)));
    }
  };

  const handleBroadcast = async (payload: any) => {
    const chatId = owner();
    if (!chatId || payload.kind !== "runtime") return;
    const event = payload.event ?? {};
    const eventBot = await botForThread(event.threadId);
    if (!eventBot) return;
    const isActive = eventBot.id === (state.activeBotId ?? botCache[0]?.id);

    switch (event.type) {
      case "content.delta":
        if (isActive && event.streamKind === "assistant_text" && event.delta) await onDelta(chatId, event.delta);
        break;
      case "item.completed":
        if (isActive && event.itemType === "assistant_text" && event.text) {
          // the settled text supersedes whatever the deltas built
          if (stream) {
            stream.text = event.text;
            await flushStream(chatId);
          } else {
            for (const part of chunkText(event.text)) await tg.send(chatId, part);
          }
        }
        break;
      case "request.opened": {
        // approvals from EVERY bot come through — that is the point of
        // having the fleet in your pocket. Non-active bots are named.
        const ask: AskEvent = {
          requestId: event.requestId,
          requestType: event.requestType === "question" ? "question" : "permission",
          tool: event.tool ?? "tool",
          summary: event.summary ?? "",
          choices: event.choices,
        };
        const sent = await tg.send(chatId, askHeader(eventBot.name, ask), keyboardFor(ask));
        // an unanswered approval is the one thing a user MUST see — say so
        // in the log, so "did it even go out?" is never a guess
        console.log(`telegram gateway: sent ${ask.requestType} card for ${eventBot.name} (${ask.tool}) → message ${sent.message_id}`);
        if (ask.requestId) asks.set(ask.requestId, { messageId: sent.message_id, ask, botId: eventBot.id });
        break;
      }
      case "request.resolved": {
        const pending = event.requestId ? asks.get(event.requestId) : undefined;
        if (pending) {
          asks.delete(event.requestId);
          await tg.clearKeyboard(chatId, pending.messageId);
          if (event.source !== "user") await tg.send(chatId, `⏱️ Resolved without you: ${event.behavior}`);
        }
        break;
      }
      case "turn.completed":
        if (isActive) {
          await flushStream(chatId);
          if (event.ok === false) await tg.send(chatId, `⚠️ ${eventBot.name}: turn failed (${event.stopReason ?? "unknown"})`);
        } else if (event.ok !== false) {
          await tg.send(chatId, `📬 ${eventBot.name} finished — /bots to switch over`);
        }
        break;
      case "runtime.error":
        if (isActive && event.message) await tg.send(chatId, `⚠️ ${String(event.message).slice(0, 300)}`);
        break;
    }
  };

  // ── long-poll telegram updates ───────────────────────────────────────
  // A long poll that outlives its socket is normal (laptop sleeps, wifi
  // drops, Telegram closes an idle connection). What is NOT acceptable is
  // hammering the API every 3s forever and logging an unreadable "fetch
  // failed" each time: back off, name the real cause, and say when the
  // connection came back so a quiet log means a healthy gateway.
  const consumeUpdates = async () => {
    let offset = 0;
    let failures = 0;
    for (;;) {
      try {
        const updates: any[] = await tg.updates(offset);
        if (failures) {
          console.log(`telegram gateway: polling recovered after ${failures} failed attempt(s)`);
          failures = 0;
        }
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          await handleUpdate(u).catch((e) => console.error("gateway update:", describeError(e)));
        }
      } catch (e) {
        failures += 1;
        // log the first few, then every tenth — an overnight outage must
        // not bury the one line that matters when you come back
        if (failures <= 3 || failures % 10 === 0) {
          console.error(`gateway poll (attempt ${failures}): ${describeError(e)}`);
        }
        await new Promise((r) => setTimeout(r, backoffMs(failures)));
      }
    }
  };

  const handleUpdate = async (u: any) => {
    const msg = u.message;
    const cb = u.callback_query;
    const chatId: number | undefined = msg?.chat?.id ?? cb?.message?.chat?.id;
    if (!chatId) return;

    // first /start claims the gateway; everyone else is turned away
    if (!state.ownerChatId) {
      if (msg?.text?.startsWith("/start")) {
        state.ownerChatId = chatId;
        saveState(state);
        console.log(`telegram gateway: owner bound to chat ${chatId}`);
      } else {
        return;
      }
    }
    if (chatId !== state.ownerChatId) {
      if (msg) await tg.send(chatId, "This gateway is bound to its owner.");
      return;
    }

    if (cb) {
      const [kind, ...rest] = String(cb.data ?? "").split(":");
      if (kind === "bot") {
        state.activeBotId = rest[0];
        saveState(state);
        stream = null;
        const bot = (await refreshBots()).find((b) => b.id === rest[0]);
        await tg.answerCallback(cb.id, bot ? `Now talking to ${bot.name}` : "Bot is gone");
        if (bot) await tg.send(chatId, `🤖 Now talking to ${bot.name} (${bot.modelSelection.model}). Just type.`);
      } else if (kind === "req") {
        const [requestId, action, choiceIx] = rest;
        const pending = asks.get(requestId);
        if (!pending) {
          await tg.answerCallback(cb.id, "Already resolved");
          return;
        }
        if (action === "prompt") {
          promptingAsk = requestId;
          await tg.answerCallback(cb.id, "Reply with your answer");
          await tg.send(chatId, "✍️ Type your answer:");
          return;
        }
        const body =
          action === "choice"
            ? { requestId, behavior: "answer", message: pending.ask.choices?.[Number(choiceIx)] ?? "" }
            : { requestId, behavior: action };
        // a failed answer must NOT look like a delivered one — the bot is
        // still waiting, so say so and leave the keyboard usable for a retry
        try {
          await api(`/api/bots/${pending.botId}/respond`, { method: "POST", body: JSON.stringify(body) });
        } catch (e) {
          console.error(`gateway respond: ${describeError(e)}`);
          await tg.answerCallback(cb.id, "Could not deliver — try again");
          await tg.send(chatId, `⚠️ Your answer did not reach ${pending.ask.tool}: ${describeError(e)}`);
          return;
        }
        await tg.answerCallback(cb.id, action === "deny" ? "Denied" : "Sent");
      }
      return;
    }

    const text: string = (msg?.text ?? "").trim();
    if (!text) return;

    if (text.startsWith("/start") || text.startsWith("/bots")) {
      const bots = await refreshBots();
      if (!bots.length) return void (await tg.send(chatId, "No bots yet — create one in the app first."));
      await tg.send(chatId, "Your bots — pick who to talk to:", botKeyboard(bots));
      return;
    }
    if (text.startsWith("/stop")) {
      const bot = await activeBot();
      if (bot) {
        await api(`/api/bots/${bot.id}/interrupt`, { method: "POST", body: "{}" });
        await tg.send(chatId, `🛑 Stopped ${bot.name}.`);
      }
      return;
    }
    // a pending free-text question answer takes the next message
    if (promptingAsk) {
      const pending = asks.get(promptingAsk);
      promptingAsk = null;
      if (pending) {
        try {
          await api(`/api/bots/${pending.botId}/respond`, {
            method: "POST",
            body: JSON.stringify({ requestId: pending.ask.requestId, behavior: "answer", message: text }),
          });
          await tg.send(chatId, "Answer sent.");
        } catch (e) {
          console.error(`gateway respond: ${describeError(e)}`);
          await tg.send(chatId, `⚠️ Your answer did not get through: ${describeError(e)}`);
        }
        return;
      }
    }
    const bot = await activeBot();
    if (!bot) return void (await tg.send(chatId, "No bots yet — create one in the app first."));
    if (!state.activeBotId) {
      state.activeBotId = bot.id;
      saveState(state);
    }
    stream = null;
    await api(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  };

  // sanity: the harness must be up, and the token must be valid
  await api("/api/health");
  console.log(`telegram gateway: bridging ${SERVER} — waiting for /start`);
  await Promise.all([consumeEvents(), consumeUpdates()]);
}

// only run the loops when executed directly (not when imported by tests)
if (process.argv[1]?.endsWith("telegram.ts") || process.argv[1]?.endsWith("telegram.js")) {
  main().catch((e) => {
    console.error("telegram gateway:", e);
    process.exit(1);
  });
}
