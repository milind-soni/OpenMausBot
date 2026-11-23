import { DAEMON_STATES } from "./types.mjs";

const VALID_TRANSITIONS = {
  BOOTSTRAPPING: new Set(["RECONCILING", "SHUTTING_DOWN"]),
  RECONCILING: new Set(["EVALUATING_POOL", "COOLDOWN_BACKOFF", "DEGRADED_READONLY", "SHUTTING_DOWN"]),
  EVALUATING_POOL: new Set(["WATCHING", "WAITING_QUIESCENT", "SYNCING_ATOMIC", "DEGRADED_READONLY", "COOLDOWN_BACKOFF", "SHUTTING_DOWN"]),
  WATCHING: new Set(["DEBOUNCING", "RECONCILING", "EVALUATING_POOL", "SHUTTING_DOWN"]),
  DEBOUNCING: new Set(["RECONCILING", "EVALUATING_POOL", "COOLDOWN_BACKOFF", "DEBOUNCING", "SHUTTING_DOWN"]),
  WAITING_QUIESCENT: new Set(["SYNCING_ATOMIC", "COOLDOWN_BACKOFF", "SHUTTING_DOWN"]),
  SYNCING_ATOMIC: new Set(["VERIFYING", "COOLDOWN_BACKOFF", "SHUTTING_DOWN"]),
  VERIFYING: new Set(["WATCHING", "WAITING_QUIESCENT", "SYNCING_ATOMIC", "DEGRADED_READONLY", "SHUTTING_DOWN"]),
  COOLDOWN_BACKOFF: new Set(["RECONCILING", "EVALUATING_POOL", "SHUTTING_DOWN"]),
  DEGRADED_READONLY: new Set(["RECONCILING", "EVALUATING_POOL", "SHUTTING_DOWN"]),
  SHUTTING_DOWN: new Set([])
};

export class DaemonFSM {
  constructor(initialState = "BOOTSTRAPPING", onStateChange = null) {
    if (!DAEMON_STATES.includes(initialState)) {
      throw new Error(`Unknown initial state: ${initialState}`);
    }
    this._state = initialState;
    this._onStateChange = onStateChange;
    this._history = [{ state: initialState, timestamp: Date.now(), reason: "initial" }];
  }

  get state() {
    return this._state;
  }

  get history() {
    return [...this._history];
  }

  canTransitionTo(nextState) {
    const legalNext = VALID_TRANSITIONS[this._state];
    return legalNext ? legalNext.has(nextState) : false;
  }

  transition(nextState, reason = "") {
    if (!this.canTransitionTo(nextState)) {
      throw new Error(`Invalid state transition from ${this._state} to ${nextState} (reason: ${reason})`);
    }

    const prevState = this._state;
    this._state = nextState;
    const record = { from: prevState, to: nextState, timestamp: Date.now(), reason };
    this._history.push(record);
    if (this._history.length > 50) {
      this._history.shift();
    }

    if (typeof this._onStateChange === "function") {
      this._onStateChange(record);
    }

    return record;
  }
}
