export const QUICK_ASKS_TITLE = "Quick asks";

export class TalkServerError extends Error {
  constructor(code) {
    super(code);
    this.name = "TalkServerError";
    this.code = code;
  }
}

export function findMausBot(bots) {
  return bots.find(bot => bot.defaultBot && !bot.defaultBot.person?.trim())
    ?? bots.find(bot => bot.chiefOfStaff && !bot.hidden)
    ?? null;
}

export async function readFrames(body, onFrame, signal) {
  const reader = body.getReader();
  const cancel = () => void reader.cancel(signal.reason).catch(() => {});
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let partial = "", data = [];
  const dispatch = () => {
    if (!data.length) return;
    let frame = null;
    try { frame = JSON.parse(data.join("\n")); } catch {}
    data = [];
    if (frame && typeof frame === "object") onFrame(frame);
  };
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      const lines = (partial + decoder.decode(value, { stream: true })).split("\n");
      partial = lines.pop();
      for (const raw of lines) {
        if (signal?.aborted) return;
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line === "") dispatch();
        else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

const waitingCard = card => !(card?.answered || card?.dismissed || card?.expired);

export function createReplyTracker({ threadId, sendId }) {
  const earlierTurns = new Set();
  let echoed = false, steered = false, turnId = null;
  let itemId, streamed = "", shown = "";
  const show = text => { shown = text; return { kind: "reply", text }; };
  const answersThisAsk = frameTurn => {
    if (frameTurn === undefined) return true;
    if (turnId !== null) return frameTurn === turnId;
    if (!steered && earlierTurns.has(frameTurn)) return false;
    turnId = frameTurn;
    return true;
  };
  return frame => {
    const event = frame.kind === "runtime" ? frame.event : undefined;
    const message = frame.kind === "message" ? frame.message : undefined;
    if ((event ? event.threadId : message ? frame.threadId : undefined) !== threadId) return null;
    const frameTurn = (event ?? message).turnId ?? undefined;
    if (!echoed) {
      if (message?.role === "user" && message.sendId === sendId) {
        echoed = true;
        steered = message.steered === true;
        return { kind: "thinking" };
      }
      if (frameTurn !== undefined) earlierTurns.add(frameTurn);
      return null;
    }
    if (!answersThisAsk(frameTurn)) return null;
    if (event) {
      if (event.type === "content.delta" && event.streamKind === "assistant_text") {
        if (event.itemId !== itemId) { itemId = event.itemId; streamed = ""; }
        streamed += event.delta;
        return show(streamed);
      }
      if (event.type === "item.completed" && event.itemType === "assistant_text") return show(event.text);
      if (event.type === "request.opened") return { kind: "needs-you" };
      if (event.type === "turn.completed") return { kind: "done", ok: event.ok, text: shown };
      return null;
    }
    if (message.role !== "bot") return null;
    if (message.kind === "text") return show(message.text ?? "");
    if (message.kind === "options" && waitingCard(message.card)) return { kind: "needs-you" };
    return null;
  };
}

const JSON_HEADERS = { "content-type": "application/json" };

/** A server whose bots moved to My Cloud refuses every change with 409 `{ code: "moved" }`. */
async function refusal(response) {
  const body = response.status === 409 ? await response.json().catch(() => null) : null;
  if (!body) void response.body?.cancel().catch(() => {});
  return new TalkServerError(body?.code === "moved" ? "moved" : "refused");
}

export function createTalkServer({ request, prefs, serverKey, starting = () => false }) {
  let preparing = null;
  const down = () => new TalkServerError(starting() ? "starting" : "server-down");

  const quickAsksChat = async () => {
    const listing = await request("/api/bots?messages=0").catch(() => null);
    const bots = listing?.ok ? (await listing.json().catch(() => null))?.bots : null;
    if (!Array.isArray(bots)) throw down();
    const bot = findMausBot(bots);
    if (!bot) throw new TalkServerError("no-mausbot");
    const server = serverKey();
    const saved = prefs.quickAsksChat(server);
    if (saved?.botId === bot.id && bot.tasks?.some(task => task.threadId === saved.threadId)) return saved;
    const made = await request(`/api/bots/${encodeURIComponent(bot.id)}/tasks`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ title: QUICK_ASKS_TITLE, select: false }),
    }).catch(() => { throw down(); });
    if (!made.ok) throw await refusal(made);
    const threadId = (await made.json().catch(() => null))?.task?.threadId;
    if (typeof threadId !== "string") throw new TalkServerError("refused");
    const chat = { botId: bot.id, threadId };
    prefs.setQuickAsksChat(server, chat);
    return chat;
  };

  const ask = ({ chat, text, sendId, signal, onUpdate }) => new Promise((resolve, reject) => {
    const reading = new AbortController();
    const track = createReplyTracker({ threadId: chat.threadId, sendId });
    let sent = false, settled = false;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      reading.abort();
      finish(value);
    };
    const aborted = () => settle(reject, signal.reason);
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });

    const send = () => request(`/api/bots/${encodeURIComponent(chat.botId)}/messages`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ text, threadId: chat.threadId, sendId }),
    }).then(
      async response => {
        if (response.ok) void response.body?.cancel().catch(() => {});
        else settle(reject, await refusal(response));
      },
      () => settle(reject, down()),
    );
    const onFrame = frame => {
      if (settled) return;
      if (!sent) {
        if (frame.kind !== "hello") return;
        sent = true;
        void send();
        return;
      }
      const update = track(frame);
      if (!update) return;
      onUpdate(update);
      if (update.kind === "done") settle(resolve, !update.ok && !update.text ? "failed" : "done");
      else if (update.kind === "needs-you") settle(resolve, "needs-you");
    };
    const ended = () => settle(reject, sent ? new TalkServerError("lost") : down());
    request("/api/events?screens=off", { signal: reading.signal })
      .then(response => {
        if (response.ok && response.body) return readFrames(response.body, onFrame, reading.signal);
        void response.body?.cancel().catch(() => {});
      })
      .then(ended, ended);
  });

  return {
    prepare() {
      preparing ??= quickAsksChat().finally(() => { preparing = null; });
      return preparing;
    },
    ask,
  };
}
