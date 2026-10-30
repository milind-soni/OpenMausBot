import { randomUUID } from "node:crypto";
import { TalkServerError } from "./talk-server.mjs";

export const TALK_TIMING = Object.freeze({ replyHideMs: 12_000, noticeHideMs: 4_000, stillWorkingMs: 120_000, hoverRecheckMs: 500, maxListenMs: 60_000 });

export const TALK_TEXT = Object.freeze({
  busy: "Voice is in use in MausBot",
  serverDown: "Open MausBot to talk",
  starting: "MausBot is still starting. Try again in a moment.",
  noMausbot: "Set up MausBot first, then try again.",
  moved: "MausBot lives on My Cloud now — talk to it there",
  permission: "Talking needs Microphone + Speech Recognition access — System Settings → Privacy & Security.",
  dictationOff: "Turn on Dictation in System Settings → Keyboard, then try again.",
  unavailable: "Talking couldn't start. Try again.",
  failed: "MausBot couldn't take that · Open chat",
});

const SPEECH_PROBLEMS = new Map([
  ["speech-not-authorized", TALK_TEXT.permission],
  ["mic-failed", TALK_TEXT.unavailable],
  ["recognizer-unavailable", TALK_TEXT.unavailable],
  ["dictation-disabled", TALK_TEXT.dictationOff],
  ["helper-build-failed", TALK_TEXT.unavailable],
  ["helper-start-failed", TALK_TEXT.unavailable],
  ["unsupported-platform", TALK_TEXT.unavailable],
]);

const SERVER_NOTICES = new Map([
  ["server-down", TALK_TEXT.serverDown],
  ["starting", TALK_TEXT.starting],
  ["no-mausbot", TALK_TEXT.noMausbot],
  ["moved", TALK_TEXT.moved],
]);

const UNDER_WAY = new Set(["listening", "sending", "thinking"]);

export function createTalkSession({ speech, server, panel, voiceInUse, release, openChat, newSendId = randomUUID }) {
  let current = null;

  const live = ask => current === ask && !ask.controller.signal.aborted;

  function begin(state) {
    const ask = { state, words: "", reply: "", chat: null, sink: null, controller: new AbortController(), listenTimer: null, hideTimer: null, answerTimer: null };
    current = ask;
    return ask;
  }

  function show(ask, state, text) {
    ask.state = state;
    try {
      panel.render({ state, text });
    } catch {}
  }

  function closeBox(ask) {
    if (current !== ask) return;
    current = null;
    clearTimeout(ask.listenTimer);
    clearTimeout(ask.hideTimer);
    clearTimeout(ask.answerTimer);
    ask.controller.abort();
    try {
      panel.close();
    } catch {}
  }

  function cancel(ask) {
    if (ask.state === "listening") speech.stop(ask.sink);
    closeBox(ask);
  }

  function hovered() {
    try {
      return panel.hovered();
    } catch {
      return false;
    }
  }

  function hideIn(ask, ms) {
    clearTimeout(ask.hideTimer);
    const check = () => {
      if (current !== ask) return;
      if (hovered()) ask.hideTimer = setTimeout(check, TALK_TIMING.hoverRecheckMs);
      else closeBox(ask);
    };
    ask.hideTimer = setTimeout(check, ms);
  }

  function settle(ask, state, text, hideMs) {
    clearTimeout(ask.answerTimer);
    show(ask, state, text);
    hideIn(ask, hideMs);
  }

  function stillWorking(ask) {
    ask.controller.abort();
    settle(ask, "still-working", ask.reply, TALK_TIMING.replyHideMs);
  }

  function failed(ask, error) {
    const code = error instanceof TalkServerError ? error.code : null;
    if (code === "lost") stillWorking(ask);
    else if (SERVER_NOTICES.has(code)) settle(ask, "error", SERVER_NOTICES.get(code), TALK_TIMING.noticeHideMs);
    else settle(ask, "error", TALK_TEXT.failed, TALK_TIMING.replyHideMs);
  }

  function follow(ask, update) {
    if (!live(ask)) return;
    if (update.kind === "thinking") show(ask, "thinking", ask.words);
    else if (update.kind === "reply") {
      ask.reply = update.text;
      show(ask, "reply", update.text);
    } else if (update.kind === "done") ask.reply = update.text;
  }

  function answered(ask, outcome) {
    if (!live(ask)) return;
    if (outcome === "done") settle(ask, "reply", ask.reply, TALK_TIMING.replyHideMs);
    else if (outcome === "needs-you") settle(ask, "needs-you", ask.reply, TALK_TIMING.replyHideMs);
    else settle(ask, "error", TALK_TEXT.failed, TALK_TIMING.replyHideMs);
  }

  function send(ask, prepared) {
    show(ask, "sending", ask.words);
    ask.answerTimer = setTimeout(() => { if (live(ask)) stillWorking(ask); }, TALK_TIMING.stillWorkingMs);
    prepared.then(chat => {
      if (!live(ask)) return;
      server.ask({
        chat,
        text: ask.words,
        sendId: newSendId(),
        signal: ask.controller.signal,
        onUpdate: update => follow(ask, update),
      }).then(outcome => answered(ask, outcome), error => { if (live(ask)) failed(ask, error); });
    }, () => {});
  }

  function listen() {
    const ask = begin("listening");
    const listening = () => current === ask && ask.state === "listening";
    show(ask, "listening", "");
    const prepared = server.prepare();
    ask.sink = {
      transcript(line) {
        if (!listening() || typeof line?.text !== "string") return;
        ask.words = line.text;
        show(ask, "listening", ask.words);
      },
      replaced() {
        if (listening()) closeBox(ask);
      },
      end(info) {
        if (!listening()) return;
        const problem = SPEECH_PROBLEMS.get(info?.reason);
        if (problem) settle(ask, "error", problem, TALK_TIMING.noticeHideMs);
        else if (!ask.words.trim()) closeBox(ask);
        else send(ask, prepared);
      },
    };
    prepared.then(chat => { ask.chat = chat; }, error => {
      if (!live(ask) || !(ask.state === "listening" || ask.state === "sending")) return;
      if (ask.state === "listening") speech.stop(ask.sink);
      failed(ask, error);
    });
    try {
      speech.start(ask.sink, { finishOnRelease: release() });
    } catch {
      if (!listening()) return;
      speech.stop(ask.sink);
      settle(ask, "error", TALK_TEXT.unavailable, TALK_TIMING.noticeHideMs);
      return;
    }
    ask.listenTimer = setTimeout(() => { if (listening()) speech.finish(ask.sink); }, TALK_TIMING.maxListenMs);
  }

  const dismiss = () => { if (current) cancel(current); };

  return {
    press() {
      if (current && UNDER_WAY.has(current.state)) return;
      dismiss();
      if (voiceInUse()) settle(begin("error"), "error", TALK_TEXT.busy, TALK_TIMING.noticeHideMs);
      else listen();
    },
    open() {
      const ask = current;
      if (!ask) return;
      const chat = ask.state === "listening" ? null : ask.chat;
      cancel(ask);
      openChat(chat);
    },
    dismiss,
    close: dismiss,
    /** Listening, or an ask on its way that has not been answered yet. */
    busy: () => Boolean(current && UNDER_WAY.has(current.state)),
  };
}
