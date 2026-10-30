// Bot replies speak from the assistant-text delta stream the server already
// broadcasts, instead of waiting for the completed message frame. Blocks close
// incrementally through the committed splitter (`/api/tts/prepare`, the voice
// path's first-block cap included) and the authoritative completed frame
// reconciles what was actually spoken.
//
// Streamed text can differ from completed text, so nothing may be spoken that
// the completed frame would redact. A block is only spoken once a later block
// exists, and every separator the splitter cuts on carries whitespace, while
// the credential shapes in shared/redact.ts are whitespace-free: masking the
// whole buffer before splitting keeps closed blocks within what the completed
// frame shows, and a credential prefix straddling chunk boundaries stays in
// the open tail. The one redaction shape that spans a separator is a
// private-key block (its body holds newlines), so an opener without its END
// holds the rest of the buffer back until the block closes or the
// authoritative frame lands. Held secret values are known only to the server,
// so `/api/tts/prepare` masks those itself.
import { redactSecretsInText } from "../../shared/redact";
import type { RuntimeEvent } from "../../shared/runtime-events";
import { currentCall } from "@/lib/call";
import { speaker, type SpeechStream } from "@/lib/tts";
import type { LiveCallState } from "../../shared/wire";

/** The bot whose reply may speak, when the store's speak gates pass. */
export interface SpokenReplyOwner {
  botId: string;
  voiceId?: string;
}

interface SpeechGateState {
  bots: readonly { id: string; threadId: string; voice?: string; speakReplies?: boolean; tasks?: readonly { threadId: string }[] }[];
  liveCall: LiveCallState | null;
}

/** The speak gates: the thread's bot speaks its replies, and no call (in-app or live) holds the speaker. */
export function speechOwner(state: SpeechGateState, threadId: string): SpokenReplyOwner | null {
  const owner = state.bots.find((b) => b.threadId === threadId || b.tasks?.some((task) => task.threadId === threadId));
  const live = state.liveCall;
  if (!owner?.speakReplies || currentCall() !== null || (live && live.status !== "ended" && live.botId === owner.id)) return null;
  return { botId: owner.id, voiceId: owner.voice };
}

/** The Speaker surface this stream drives. */
export interface ReplySpeechSink {
  begin(opts: { botId?: string; voiceId?: string; messageId?: string }): SpeechStream;
}

function speakableStreamText(buffer: string): string {
  const redacted = redactSecretsInText(buffer);
  for (const match of redacted.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)) {
    const body = redacted.slice(match.index + match[0].length);
    if (!/-----END [A-Z ]*PRIVATE KEY-----/.test(body)) return redacted.slice(0, match.index);
  }
  return redacted;
}

interface TurnSpeech {
  threadId: string;
  /** The bot whose reply this turn speaks; a live call on it silences the turn. */
  botId: string;
  turnId?: string;
  stream: SpeechStream;
  /** Concatenated assistant-text deltas of the burst since the last reset. */
  buffer: string;
  /** Buffer length when the authoritative frame landed: text after it belongs to a later burst and survives the supersession. */
  authoritativeCut: number;
  /** Blocks already pushed for this burst. */
  spoken: string[];
  /** Completed-frame text waiting to reconcile. */
  authoritative: string | null;
  pumping: boolean;
  dirty: boolean;
  ended: boolean;
}

const sameTurn = (turn: TurnSpeech, turnId: string | undefined): boolean =>
  turn.turnId === undefined || turnId === undefined || turn.turnId === turnId;

export class SpokenReplyStream {
  private readonly turns = new Map<string, TurnSpeech>();

  constructor(private readonly speech: ReplySpeechSink) {}

  onRuntimeEvent(event: RuntimeEvent, owner: SpokenReplyOwner | null): void {
    if (event.type === "turn.started") {
      const current = this.turns.get(event.threadId);
      if (current) this.drop(current);
      return;
    }
    if (event.type === "turn.completed") {
      this.finishTurn(event.threadId, event.turnId, event.ok);
      return;
    }
    if (event.type === "content.delta" && event.streamKind === "assistant_text" && owner) {
      this.appendDelta(event.threadId, event.turnId, event.delta, owner);
    }
  }

  /** A live call takes the bot's speaker: its queued and playing reply speech stops. */
  onLiveCall(call: LiveCallState | null): void {
    if (!call || call.status === "ended") return;
    for (const turn of this.turns.values()) {
      if (turn.botId !== call.botId) continue;
      this.turns.delete(turn.threadId);
      turn.ended = true;
      turn.authoritative = null;
      turn.dirty = false;
      turn.stream.cancel();
    }
  }

  /** The authoritative bot-text frame for a reply. `owner` null means the
   * store's speak gates fail now, and a live stream must go silent. */
  completeBotText(threadId: string, turnId: string | undefined, text: string, owner: SpokenReplyOwner | null, messageId?: string): void {
    const current = this.turns.get(threadId);
    if (current && sameTurn(current, turnId)) {
      if (!owner) {
        this.turns.delete(threadId);
        current.ended = true;
        current.stream.cancel();
        return;
      }
      current.stream.identify(messageId);
      current.authoritativeCut = current.buffer.length;
      current.authoritative = text;
      this.pump(current);
      return;
    }
    if (!owner || !text.trim()) return;
    const turn: TurnSpeech = {
      threadId,
      botId: owner.botId,
      turnId,
      stream: this.speech.begin({ botId: owner.botId, voiceId: owner.voiceId, messageId }),
      buffer: "",
      authoritativeCut: 0,
      spoken: [],
      authoritative: text,
      pumping: false,
      dirty: false,
      ended: false,
    };
    this.turns.set(threadId, turn);
    this.pump(turn);
    this.finishTurn(threadId, turnId, true);
  }

  private appendDelta(threadId: string, turnId: string | undefined, delta: string, owner: SpokenReplyOwner): void {
    const current = this.turns.get(threadId);
    if (current && sameTurn(current, turnId)) {
      current.buffer += delta;
      current.dirty = true;
      this.pump(current);
      return;
    }
    if (current) this.drop(current);
    const turn: TurnSpeech = {
      threadId,
      botId: owner.botId,
      turnId,
      // begin stops whatever was speaking: a new turn's audio supersedes it.
      stream: this.speech.begin({ botId: owner.botId, voiceId: owner.voiceId }),
      buffer: delta,
      authoritativeCut: 0,
      spoken: [],
      authoritative: null,
      pumping: false,
      dirty: true,
      ended: false,
    };
    this.turns.set(threadId, turn);
    this.pump(turn);
  }

  private drop(turn: TurnSpeech): void {
    if (this.turns.get(turn.threadId) !== turn) return;
    this.turns.delete(turn.threadId);
    turn.ended = true;
    void turn.stream.end();
  }

  private finishTurn(threadId: string, turnId: string | undefined, ok: boolean): void {
    const current = this.turns.get(threadId);
    if (!current || !sameTurn(current, turnId)) return;
    if (!ok) {
      this.turns.delete(threadId);
      current.ended = true;
      current.stream.cancel();
      return;
    }
    current.ended = true;
    this.pump(current);
  }

  /** One sequential loop per turn: prepares and pushes stay in arrival order. */
  private pump(turn: TurnSpeech): void {
    if (turn.pumping) {
      turn.dirty = true;
      return;
    }
    turn.pumping = true;
    void (async () => {
      try {
        for (;;) {
          if (turn.authoritative !== null) {
            const text = turn.authoritative;
            turn.authoritative = null;
            // Reset before the await: deltas that land while prepare is in
            // flight sit past authoritativeCut and survive as a dirty pump,
            // instead of being wiped by this supersession.
            const spoken = turn.spoken;
            turn.spoken = [];
            turn.buffer = turn.buffer.slice(turn.authoritativeCut);
            turn.authoritativeCut = 0;
            if (turn.buffer) turn.dirty = true;
            const blocks = await turn.stream.prepare(speakableStreamText(text));
            let resume = 0;
            while (resume < spoken.length && resume < blocks.length && spoken[resume] === blocks[resume]) resume += 1;
            // Re-speak from the first divergence: content the authoritative
            // frame holds is never dropped, and this matches what speaking the
            // completed frame alone would have said.
            for (const block of blocks.slice(resume)) turn.stream.push(block);
            continue;
          }
          if (turn.dirty && !turn.ended) {
            turn.dirty = false;
            const blocks = await turn.stream.prepare(speakableStreamText(turn.buffer));
            const closed = blocks.slice(0, -1);
            for (const block of closed.slice(turn.spoken.length)) turn.stream.push(block);
            turn.spoken = closed;
            continue;
          }
          break;
        }
      } catch (error) {
        if (this.turns.get(turn.threadId) === turn) this.turns.delete(turn.threadId);
        turn.stream.fail(error instanceof Error ? error.message : String(error));
        return;
      }
      turn.pumping = false;
      if (turn.ended && this.turns.get(turn.threadId) === turn) {
        this.turns.delete(turn.threadId);
        void turn.stream.end();
      }
    })();
  }
}

export const spokenReplyStream = new SpokenReplyStream(speaker);
