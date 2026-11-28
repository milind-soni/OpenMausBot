// Words spoken on a Live call are never logged: such a turn shows `text=(spoken)`.

export interface TurnStartLog {
  botId: string;
  text: string;
  images: number;
  depth: number;
  card: boolean;
  spoken: boolean;
}

const LOGGED_CHARS = 70;

/** Spoken words never reach the log: this turn or its message came in on a call. */
export function spokenTurn(via: string | undefined, messageVia: string | undefined, lineIds: ReadonlySet<string>, messages: readonly { id: string; via?: string }[]): boolean {
  return via === "call" || messageVia === "call" || (lineIds.size > 0 && messages.some((message) => lineIds.has(message.id) && message.via === "call"));
}

export function turnStartLogLine(turn: TurnStartLog): string {
  const text = turn.spoken ? "(spoken)" : JSON.stringify(turn.text.slice(0, LOGGED_CHARS));
  return `[omb-turn] bot=${turn.botId} text=${text} images=${turn.images} depth=${turn.depth} card=${turn.card}`;
}
