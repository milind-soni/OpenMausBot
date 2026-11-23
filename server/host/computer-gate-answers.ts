import { CONTROL_HANDED_BACK, CONTROL_WAITED, CONTROL_WAITED_HELD, type ControlState } from "../control-client.ts";
import { computerBusyText, computerQueuedText } from "../computer-wait.ts";
import type { TurnOwner, TurnResources } from "../turn-resources.ts";

export const PERSON_HOLDS = "person";

/** A person's hold on the keys a conversation's own computer reads, and the latest hold started on any of them. */
export interface PersonOnBot {
  held: () => boolean;
  lastTake: () => number;
}

export interface ComputerGateAnswersDeps {
  resources: TurnResources;
  /** The computer seat this thread's turn is bound to, if any. */
  bound: (threadId: string) => { owner: TurnOwner; resource: string } | undefined;
  personHolds: (resource: string) => boolean;
  /** The latest hold a person started on this seat, as a `takeSequence`, so a take and hand-back between two looks still shows. */
  personLastTake: (resource: string) => number;
  pollMs: number;
}

/** What a screen call that was not performed tells the model, from what holds at that moment. */
export function createComputerGateAnswers(deps: ComputerGateAnswersDeps) {
  const boundSeat = (owner: TurnOwner) => {
    const bound = deps.bound(owner.threadId);
    return bound && bound.owner.generation === owner.generation ? bound : undefined;
  };

  /**
   * Checked on the seat the turn actually queues for: a bot falling back to the shared desktop waits on a resource its
   * own control key does not name. A queue place alone never claims that another thread is using the computer.
   */
  function contention(owner: TurnOwner): string | undefined {
    const waiting = deps.resources.computerWaitOf(owner);
    const resource = waiting?.resource ?? boundSeat(owner)?.resource;
    if (!resource) return undefined;
    if (deps.personHolds(resource)) return PERSON_HOLDS;
    const blocker = deps.resources.blocker(resource, owner);
    const since = deps.resources.holderSince(resource);
    const facts = { estimateMs: deps.resources.waitEstimateMs(resource), ...(blocker && since !== undefined ? { heldForMs: Date.now() - since } : {}) };
    if (blocker) return computerBusyText({ ...facts, ...(waiting ? { position: waiting.position } : {}) });
    return waiting ? computerQueuedText({ ...facts, position: waiting.position }) : undefined;
  }

  /** Whether a person holds this turn's computer now, or started a hold on it after `since` (a `takeSequence`), even one already handed back. */
  function personCame(owner: TurnOwner, person: PersonOnBot, since: number): boolean {
    if (person.held() || person.lastTake() > since) return true;
    const seat = deps.resources.computerWaitOf(owner)?.resource ?? boundSeat(owner)?.resource;
    return seat !== undefined && (deps.personHolds(seat) || deps.personLastTake(seat) > since);
  }

  /**
   * Waits for a pending claim and says whether a person took the computer meanwhile, even one who already handed it back:
   * a click composed before a person took the screen must not land on whatever is there now.
   */
  async function waitForClaim(begin: Promise<unknown>, until: number, owner: TurnOwner, person: PersonOnBot, since: number, signal?: AbortSignal): Promise<boolean> {
    let settled = false;
    let wake: (() => void) | undefined;
    const settle = () => { settled = true; wake?.(); };
    begin.then(settle, settle);
    const tick = (ms: number) => new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); wake = undefined; resolve(); };
      const timer = setTimeout(done, Math.max(0, ms));
      signal?.addEventListener("abort", done, { once: true });
      wake = done;
    });
    let personSeen = personCame(owner, person, since);
    while (!settled && Date.now() < until && !signal?.aborted) {
      await tick(Math.min(deps.pollMs, until - Date.now()));
      personSeen = personCame(owner, person, since) || personSeen;
    }
    return personSeen;
  }

  return {
    contention,
    personCame,
    /** A claim that must be retried after a person took the computer and handed it back asks for a fresh screenshot first. */
    retry(owner: TurnOwner, personCameMeanwhile: boolean, retryText: string): string {
      return personCameMeanwhile && contention(owner) !== PERSON_HOLDS ? CONTROL_HANDED_BACK : retryText;
    },
    waitForClaim,
    held(reason: string, helpOpen: boolean): ControlState {
      return reason === PERSON_HOLDS ? { held: true, helpOpen, reason: "person" } : { held: true, helpOpen: false, blockedReason: reason };
    },
    /** "Now has this computer" only for a seat the server sees this turn holding. */
    waited(owner: TurnOwner): string {
      const bound = boundSeat(owner);
      return bound && deps.resources.owns(bound.resource, bound.owner) ? CONTROL_WAITED_HELD : CONTROL_WAITED;
    },
  };
}
