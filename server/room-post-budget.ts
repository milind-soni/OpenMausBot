// How much a room will take from its bots before it stops them.
//
// post_to_room is the first tool that lets a bot write into a shared
// channel without a person or a turn asking it to, and the published
// failure mode for exactly that shape is not subtle: Claude Code subagents
// recursed past fifty levels and burned four million tokens in under five
// minutes, because the limits did not inherit and because each refusal
// looked, to the model, like a reason to try again. So the budget is a
// property of the ROOM, not of any one caller, and every refusal is worded
// to end the attempt rather than to invite the next one.
//
// Four rules, because each catches something the others miss:
//
//   duplicate     the same bot re-sending the same text — a retry loop that
//                 never noticed its first post landed
//   ring          A → B → C → A. Per-sender limits cannot see this: every
//                 bot posted once. It is caught by watching the room's
//                 sequence of speakers close on itself
//   sender rate   one bot flooding a room it is otherwise entitled to use
//   escalation    the room-wide ceiling that fails TOWARD the human: past
//                 it the answer is "ask the user", not "wait and retry"
//
// The ceiling counts the posts NOBODY HAS ANSWERED — the ones since the
// person last wrote in the room — rather than every post in the window.
// That is the difference between the failure this file exists to stop and
// ordinary use: bots filling a room no one is reading is the loop, while a
// room where the person is replying already has the human the ceiling would
// otherwise go and fetch. It is also what leaves the other three rules any
// air: counted flat, a ceiling of two would cap the room's whole history at
// two posts, and a per-sender window of ten or a ring of four could never
// be reached at all — three rules that could not fire, with tests that only
// passed because they were handed a history the server cannot produce.
//
// The decision is a pure function of the recorded state plus a caller-
// supplied `now`, so the server can pass Date.now() and tests can pass
// whatever they need to place an event on either side of a window.

/** One bot-authored post the budget has already allowed. */
export interface RoomPostRecord {
  botId: string;
  /** Compared verbatim for the duplicate rule; never re-emitted anywhere. */
  text: string;
  at: number;
}

/** Everything one room's budget remembers. Serializable on purpose: it is
 * only ever in memory today, but nothing here would stop it being saved. */
export interface RoomPostBudget {
  posts: RoomPostRecord[];
  /** When the ring breaker last tripped, if it has. */
  trippedAt?: number;
}

export type RoomPostRefusal = "duplicate" | "ring" | "breaker" | "sender-rate" | "escalate";

export type RoomPostDecision =
  | { allowed: true; budget: RoomPostBudget }
  | { allowed: false; refusal: RoomPostRefusal; message: string; budget: RoomPostBudget };

/** One bot's request to write into the room. */
export interface RoomPostAttempt {
  botId: string;
  botName: string;
  text: string;
  now: number;
  /** When a person last wrote in the room, if one ever has. Only the
   * ceiling reads it: a person speaking is the room being attended, which
   * is the state the ceiling is trying to reach. Absent means nobody has
   * spoken there at all, and then every post in the window counts. */
  lastHumanAt?: number;
}

/** Posts by one bot per minute. Generous next to the ceiling below —
 * it exists to stop one bot monopolising a room the others may still use. */
const SENDER_WINDOW_MS = 60_000;
const SENDER_MAX = 10;
/** How long an identical repost stays a duplicate rather than an update. */
const DUPLICATE_WINDOW_MS = 60_000;
/** How far back the speaker sequence is read when looking for a ring. */
const RING_WINDOW_MS = 120_000;
/** How long the room stays shut after a ring — long enough that the turns
 * which formed it have all ended. */
const BREAKER_COOLDOWN_MS = 5 * 60_000;
/** The room-wide ceiling, and the window it is counted over: the third
 * unanswered bot post inside the window is refused and sent to the human.
 * "Unanswered" is doing the work — the count restarts when a person writes
 * in the room, so the ceiling measures bots talking past a person rather
 * than a room's total traffic. */
const ESCALATE_WINDOW_MS = 5 * 60_000;
const ESCALATE_MAX = 2;
/** Nothing older than the widest window can change any answer. */
const RETENTION_MS = Math.max(SENDER_WINDOW_MS, DUPLICATE_WINDOW_MS, RING_WINDOW_MS, ESCALATE_WINDOW_MS);

/** A room that has never been posted into. */
export function emptyRoomPostBudget(): RoomPostBudget {
  return { posts: [] };
}

/** The tail of the speaker sequence, oldest first. */
function recentSenders(posts: RoomPostRecord[], now: number): string[] {
  return posts.filter((post) => now - post.at < RING_WINDOW_MS).map((post) => post.botId);
}

/** True when `candidate` closes a three-bot ring: the last four speakers
 * are X, Y, Z, X with X, Y and Z all different. Pairwise limits are blind
 * to this — no bot spoke twice in a row and none of them spoke often. */
function closesRing(senders: string[], candidate: string): boolean {
  const tail = [...senders.slice(-3), candidate];
  if (tail.length < 4) return false;
  const [first, second, third, last] = tail;
  return first === last && new Set([first, second, third]).size === 3;
}

/**
 * Decide whether one bot may post into one room, and return the budget to
 * remember. Refusals never record the attempt: a refused post did not
 * happen, and counting it would let a blocked bot deepen its own block.
 */
export function decideRoomPost(budget: RoomPostBudget, attempt: RoomPostAttempt): RoomPostDecision {
  const { botId, botName, text, now, lastHumanAt } = attempt;
  const posts = budget.posts.filter((post) => now - post.at < RETENTION_MS);
  const tripped = budget.trippedAt !== undefined && now - budget.trippedAt < BREAKER_COOLDOWN_MS
    ? budget.trippedAt
    : undefined;
  const kept: RoomPostBudget = tripped === undefined ? { posts } : { posts, trippedAt: tripped };
  const refuse = (refusal: RoomPostRefusal, message: string, next = kept): RoomPostDecision => ({
    allowed: false,
    refusal,
    message,
    budget: next,
  });

  if (tripped !== undefined) {
    return refuse(
      "breaker",
      "Posting into this room is closed: its bots were answering each other in a loop. Do not call post_to_room again for this room — say what you wanted to post in your own reply, where the user will read it.",
    );
  }
  const duplicate = posts.some(
    (post) => post.botId === botId && post.text === text && now - post.at < DUPLICATE_WINDOW_MS,
  );
  if (duplicate) {
    return refuse(
      "duplicate",
      "You already posted that exact message in this room a moment ago, and it is still there. Do not post it again; treat it as delivered and move on.",
    );
  }
  if (closesRing(recentSenders(posts, now), botId)) {
    return refuse(
      "ring",
      `Posting into this room is now closed: ${botName} is completing a loop the room's bots have been passing between themselves. Do not retry, and do not post to another room instead — tell the user what is going round and let them decide.`,
      { posts, trippedAt: now },
    );
  }
  const bySender = posts.filter((post) => post.botId === botId && now - post.at < SENDER_WINDOW_MS).length;
  if (bySender >= SENDER_MAX) {
    return refuse(
      "sender-rate",
      `You have posted ${SENDER_MAX} times in this room in the last minute, which is the limit. Do not retry this call — finish your turn and say anything further to the user directly.`,
    );
  }
  const unanswered = posts.filter(
    (post) => now - post.at < ESCALATE_WINDOW_MS && (lastHumanAt === undefined || post.at > lastHumanAt),
  ).length;
  if (unanswered >= ESCALATE_MAX) {
    return refuse(
      "escalate",
      `This room has already taken ${unanswered} bot posts that nobody has answered, which is as far as bots go without a person. Stop posting and ask the user what they want said in the room — tell them that anything they write in the room themselves re-opens it, and that it also re-opens by itself after a few minutes. Do not retry this call.`,
    );
  }
  return { allowed: true, budget: { posts: [...posts, { botId, text, at: now }] } };
}
