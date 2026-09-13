import { describe, expect, it } from "vitest";

import {
  accumulate,
  dictationQueryUrl,
  dictationSocketProtocols,
  resultText,
  startDictationSession,
  transcriptText,
} from "./dictation-stt.mjs";

// NOTE: dictation-stt.mjs does not export EMPTY — it works on plain
// {finalText, partialText} objects; this is the local empty state.
const empty = () => ({ finalText: "", partialText: "" });

function resultsMessage(text, { isFinal = false, speechFinal = false } = {}) {
  return {
    type: "Results",
    is_final: isFinal,
    speech_final: speechFinal,
    channel: { alternatives: [{ transcript: text }] },
  };
}

class FakeSocket {
  constructor() {
    this.listeners = {};
    this.sent = [];
    this.readyState = 1;
  }

  addEventListener(name, handler) {
    (this.listeners[name] ??= []).push(handler);
  }

  removeEventListener(name, handler) {
    this.listeners[name] = (this.listeners[name] ?? []).filter((h) => h !== handler);
  }

  emit(name, event) {
    for (const handler of this.listeners[name] ?? []) handler(event);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  serverMessage(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

describe("dictationQueryUrl", () => {
  it("builds the streaming URL with the dictation contract", () => {
    const url = new URL(dictationQueryUrl());
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("api.deepgram.com");
    expect(url.pathname).toBe("/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("channels")).toBe("1");
    expect(url.searchParams.get("punctuate")).toBe("true");
    expect(url.searchParams.get("smart_format")).toBe("true");
    // the key must never ride the URL (logs): auth goes via subprotocol
    expect(url.search).not.toContain("key=");
  });
});

describe("dictationSocketProtocols", () => {
  it("carries the Deepgram token auth without exposing the key in any URL", () => {
    expect(dictationSocketProtocols("dg-secret")).toEqual(["token", "dg-secret"]);
  });
});

describe("accumulate", () => {
  it("returns state unchanged for non-word messages", () => {
    const state = empty();
    expect(accumulate(state, { type: "Metadata" })).toBe(state);
    expect(accumulate(state, { type: "UtteranceEnd" })).toBe(state);
    expect(accumulate(state, resultsMessage(""))).toBe(state);
  });

  it("commits is_final chunks to finalText and clears the partial", () => {
    let state = accumulate(empty(), resultsMessage("hello", { isFinal: true }));
    state = accumulate(state, resultsMessage("world", { isFinal: true }));
    expect(state.finalText).toBe("hello world");
    expect(state.partialText).toBe("");
  });

  it("keeps interim results in partialText until a boundary", () => {
    let state = accumulate(empty(), resultsMessage("hel"));
    expect(state).toEqual({ finalText: "", partialText: "hel" });
    state = accumulate(state, resultsMessage("hello", { isFinal: true }));
    expect(state).toEqual({ finalText: "hello", partialText: "" });
  });

  it("a lone speech_final boundary does not double-count the utterance", () => {
    let state = accumulate(empty(), resultsMessage("one two", { isFinal: true }));
    state = accumulate(state, resultsMessage("three"));
    // Deepgram sends speech_final on the SAME message as the chunk's is_final,
    // or alone; either way the partial must survive until its is_final lands.
    state = accumulate(state, resultsMessage("three", { speechFinal: true }));
    expect(state.finalText).toBe("one two");
    expect(state.partialText).toBe("three");
  });
});

describe("transcriptText", () => {
  it("joins final and trailing partial", () => {
    expect(transcriptText({ finalText: "a b", partialText: "c" })).toBe("a b c");
    expect(transcriptText({ finalText: "", partialText: "" })).toBe("");
  });
});

describe("startDictationSession", () => {
  it("feeds audio only while open and finalizes on the first is_final after Finalize", async () => {
    const socket = new FakeSocket();
    const partials = [];
    const session = startDictationSession({
      socket,
      onPartial: (partialText) => partials.push(partialText),
    });

    const serverChunk = resultsMessage("hi", { isFinal: true });
    socket.serverMessage(serverChunk);
    expect(partials).toContain("hi");

    const pending = session.finish();
    // Finalize went out before resolution.
    expect(socket.sent.some((data) => data === '{"type":"Finalize"}')).toBe(true);
    socket.serverMessage(resultsMessage("hi there", { isFinal: true }));
    const text = await pending;
    expect(text).toBe("hi hi there");
    expect(session.textSoFar()).toBe("hi hi there");
  });

  it("resolves with the accumulated text when the socket dies mid-finish", async () => {
    const socket = new FakeSocket();
    const session = startDictationSession({ socket });
    socket.serverMessage(resultsMessage("kept", { isFinal: true }));
    const pending = session.finish();
    socket.close();
    await expect(pending).resolves.toBe("kept");
  });

  it("cancel closes the socket and leaves nothing pending", () => {
    const socket = new FakeSocket();
    const session = startDictationSession({ socket });
    session.cancel();
    expect(socket.readyState).toBe(3);
  });

  it("resultText ignores malformed frames", () => {
    expect(resultText({ type: "Results" })).toBe(null);
    expect(resultText(undefined)).toBe(null);
  });
});
