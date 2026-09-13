// Deepgram streaming speech-to-text for hold-to-dictate. One WebSocket per
// hold; the renderer sends PCM16/16 kHz frames and receives partials plus the
// final transcript. Pure helpers live here so the wire logic is testable
// without Electron or a network.
//
// Wire contract (api.deepgram.com/v1/listen streaming):
//   client → {type:"Finalize"} asks the server to flush every buffered byte
//   as final results — exactly hold-release semantics.
//   server → Results messages: is_final=true marks a phrase-final chunk;
//   speech_final=true marks an endpointed utterance. Interims are cumulative
//   within a chunk. Accumulation for dictation: is_final text appends to the
//   committed transcript, interims replace the trailing partial.

export const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";

/** The streaming query Deepgram needs for dictation. Kept explicit: every
 * parameter here changes product behavior, not just the wire. The API key is
 * deliberately NOT a query param — URLs end up in logs — it rides the
 * `Sec-WebSocket-Protocol` header via dictationSocketProtocols below
 * (Deepgram's documented pattern for header-less WebSocket clients). */
export function dictationQueryUrl() {
  const params = new URLSearchParams({
    model: "nova-3",
    // PCM 16-bit signed little-endian, 16 kHz mono — the exact format the
    // renderer's downsample pipeline produces.
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    // Punctuation and smart formatting produce paste-ready prose.
    punctuate: "true",
    smart_format: "true",
    // Endpointing keeps long holds from ballooning the partial buffer;
    // Finalize alone already covers hold-release semantics.
    endpointing: "300",
    utterance_end_ms: "1000",
  });
  return `${DEEPGRAM_WS_URL}?${params.toString()}`;
}

/** WebSocket subprotocols carrying Deepgram auth: the global WebSocket
 * (browser and Node's undici) has no header option, but its `protocols`
 * argument maps straight to Sec-WebSocket-Protocol. */
export function dictationSocketProtocols(apiKey) {
  return ["token", apiKey];
}

/** Extract readable text from one Results message, or null when the message
 * carries no words (metadata, UtteranceEnd, keep-alives…). */
export function resultText(message) {
  const alternative = message?.type === "Results"
    ? message.channel?.alternatives?.[0]
    : undefined;
  const text = typeof alternative?.transcript === "string" ? alternative.transcript : "";
  return text ? text : null;
}

export function isFinalResult(message) {
  return message?.type === "Results" && message.is_final === true;
}

export function isSpeechFinal(message) {
  return message?.type === "Results" && message.speech_final === true;
}

/** Roll one server message into the running transcript. Deepgram interims
 * are cumulative within a chunk, so each interim REPLACES the partial; an
 * `is_final` chunk supersedes its interims and appends its own text; a lone
 * `speech_final` boundary keeps the partial (its is_final follows). */
export function accumulate(state, message) {
  const text = resultText(message);
  if (!text) return state;
  if (isFinalResult(message)) {
    const final = state.finalText ? `${state.finalText} ${text}`.trim() : text;
    return { finalText: final, partialText: "" };
  }
  if (isSpeechFinal(message)) return state;
  return { ...state, partialText: text };
}

/** The final paste text: every committed chunk plus the trailing partial. */
export function transcriptText(state) {
  return `${state.finalText} ${state.partialText}`.trim();
}

/** One dictation session over the given WebSocket-like object. The injected
 * transport keeps the wire swappable for tests. Exactly ONE message listener
 * owns the state: live partials and the finalize handshake both flow through
 * it, so no server message is ever accumulated twice. */
export function startDictationSession({ socket, onPartial, onError, onOpen }) {
  // Reassigned as results arrive; helpers take/return the value so the
  // accumulation logic itself stays pure and testable.
  let state = { finalText: "", partialText: "" };
  let finalizeWaiter = null;
  let finished = false;

  const ingest = (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    // onPartial carries the RUNNING transcript (committed + interim), so a
    // single-phrase hold — one is_final, never an interim — still shows text.
    const before = transcriptText(state);
    state = accumulate(state, message);
    const after = transcriptText(state);
    if (after !== before && onPartial) onPartial(after);
    // Finalize's flush ends in an is_final result; that (or a close) ends
    // the wait.
    if (finalizeWaiter && isFinalResult(message)) {
      const waiter = finalizeWaiter;
      finalizeWaiter = null;
      waiter();
    }
  };

  socket.addEventListener("message", ingest);
  socket.addEventListener("open", () => onOpen?.());
  socket.addEventListener("error", () => {
    if (finished) return;
    onError?.("Could not reach the transcription stream. Check your Deepgram key and connection.");
  });

  return {
    /** Feed one chunk of PCM16 audio bytes. */
    send(chunk) {
      if (socket.readyState === 1) socket.send(chunk);
    },
    /** Hold released: flush Deepgram's buffer and resolve the paste text. */
    finish() {
      if (finished) return Promise.resolve(transcriptText(state));
      finished = true;
      return new Promise((resolve) => {
        if (socket.readyState !== 1) {
          resolve(transcriptText(state));
          return;
        }
        const timeout = setTimeout(() => {
          finalizeWaiter = null;
          resolve(transcriptText(state));
        }, 2500);
        const onDone = () => {
          clearTimeout(timeout);
          resolve(transcriptText(state));
        };
        finalizeWaiter = onDone;
        const onClose = () => {
          if (finalizeWaiter === onDone) {
            clearTimeout(timeout);
            finalizeWaiter = null;
            resolve(transcriptText(state));
          }
        };
        socket.addEventListener("close", onClose, { once: true });
        socket.send(JSON.stringify({ type: "Finalize" }));
      });
    },
    /** Escape path: stop listening, drop everything buffered. */
    cancel() {
      finished = true;
      finalizeWaiter = null;
      try {
        socket.close(1000);
      } catch {}
    },
    /** Text so far, for a focus-loss finalize on a socket that already died. */
    textSoFar() {
      return transcriptText(state);
    },
  };
}
