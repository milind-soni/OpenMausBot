/** What MausBot is doing about a cloud computer that stopped answering, as `GET /api/bots/:id/computer/recovery` reports it.
 * `not-responding`, `restoring`, `restarting` and `replacing` are under way; the others are how it ended. `restoring`: the
 * provider says the computer's disk is still being put back after a wake, so it is waited for before any restart. */
export const CLOUD_COMPUTER_RECOVERY_STATES = [
  "not-responding", "restoring", "restarting", "replacing", "restarted", "replaced", "unreachable", "capped", "needs-person",
] as const;
export type CloudComputerRecoveryState = (typeof CLOUD_COMPUTER_RECOVERY_STATES)[number];

export interface CloudComputerRecovery {
  state: CloudComputerRecoveryState;
  at: number;
  /** The person asked for it from the computer panel. */
  manual?: true;
}

export const recoveryUnderWay = (state: CloudComputerRecoveryState): boolean =>
  state === "not-responding" || state === "restoring" || state === "restarting" || state === "replacing";

/** Whether the computer answers commands, beside `recovery`, on the same route. `since`: when the wait or the silence began. */
export interface CloudComputerAnswering {
  state: "awake" | "waking" | "restoring" | "not-responding";
  since?: number;
  /** When a command last got an answer, since the server started. */
  lastAnsweredAt: number | null;
}

/** From this share of the disk used, the computer's caches are cleared and the panel shows the figure. */
export const DISK_WARN_PERCENT = 85;

/** The computer's disk, beside `answering`, on the same route; absent or null while it is under DISK_WARN_PERCENT and
 * nothing was cleared in the last day. `percent`: the fullest of its root and home filesystems. `clearedAt`: when its caches
 * were last cleared. `spaceClearedAt`: when more than caches was last removed to keep it from filling, given in place of `clearedAt`. */
export interface CloudComputerDisk {
  percent: number;
  clearedAt?: number;
  spaceClearedAt?: number;
}

/** What the bot is told, in place of a computer call, while its computer is not answering and MausBot is bringing it
 * back, and the call waited for that as long as it could. Says nothing of a replacement, which may be switched off. */
export const CLOUD_COMPUTER_NOT_RESPONDING =
  "This bot's cloud computer isn't responding yet. MausBot keeps trying to bring it back by itself, and this turn can go on once it answers. This call was not performed. Repeat it in a minute.";
/** The same, for a call that was sent and got no answer. */
export const CLOUD_COMPUTER_NOT_RESPONDING_UNANSWERED =
  "This bot's cloud computer isn't responding yet, so this call got no answer and most likely did not run. MausBot keeps trying to bring it back by itself. Take a fresh screenshot in a minute before repeating it.";
/** Every guard passed: the silent computer is being set aside and a new one made for this turn. */
export const CLOUD_COMPUTER_REPLACING =
  "This bot's cloud computer still did not answer after a restart, so MausBot is setting it aside, with its files, and giving this bot a new one. This call was not performed. Repeat it in a minute.";
/** The turn's computer was set aside while this call waited, and the new one is not up yet. */
export const CLOUD_COMPUTER_REPLACEMENT_STARTING =
  "This bot's cloud computer stopped responding and was set aside; its new one is still starting. This call was not performed. Repeat it in a minute.";
/** A call that waited out its computer's restart or replacement: only a look at the screen is made after such a wait,
 * since the bot has not seen what the computer is like now. */
export const CLOUD_COMPUTER_ANSWERS_AGAIN =
  "The cloud computer answers again. This call was not performed while MausBot waited for it: take a fresh screenshot, then repeat it.";
/** Woken and not answering yet, inside the wake's patience: the call is not counted against the computer. */
export const CLOUD_COMPUTER_WAKING =
  "The cloud computer is awake but not answering yet; MausBot keeps waiting for it. This call was not performed. Repeat it in a moment.";
/** While it is being stopped and started again, which keeps its files. */
export const CLOUD_COMPUTER_RESTARTING =
  "This bot's cloud computer stopped responding and MausBot is restarting it; its files are kept. This call was not performed. Try again in a minute.";
export const CLOUD_COMPUTER_RESTARTING_UNANSWERED =
  "This bot's cloud computer stopped responding and MausBot is restarting it; its files are kept. This call got no answer and most likely did not run. Try again in a minute.";
/** While the provider is still putting its disk back after a wake. */
export const CLOUD_COMPUTER_RESTORING =
  "This bot's cloud computer is awake but still restoring its disk, so it is not answering yet. This call was not performed. Try again in a minute.";
/** Told once, on the bot's first computer call after the replacement: one the provider reported broken and that could
 * not even be stopped, so it was deleted. */
export const CLOUD_COMPUTER_REPLACED =
  "This bot's cloud computer stopped working and was replaced with a new one. Files, programs and sign-ins that were only on the old computer are gone: clone, download or install again, and sign in again, as this task needs.";
/** Told once, on the bot's first computer call after its silent computer was set aside, kept until `date`. */
export const cloudComputerSetAsideNotice = (date: string): string =>
  `This bot's cloud computer stopped responding, so MausBot set it aside and gave this bot a new one. The old computer is kept, stopped and with its files, until ${date}; `
  + "the person finds it in Settings → Desktops & browser → Desktops. Files, programs and sign-ins that were only on the old computer are not on the new one: "
  + "clone, download or install again, and sign in again, as this task needs.";
export const CLOUD_COMPUTER_REPLACED_BY_PERSON =
  "This bot's cloud computer was replaced with a new one. Files that were only on the old computer are gone.";
export const CLOUD_COMPUTER_RESTARTED =
  "This bot's cloud computer stopped responding and was restarted. Programs that were open on it were closed; its files are still there.";
export const CLOUD_COMPUTER_UNREACHABLE =
  "Cloud computers can't be reached right now. This call may not have run. Try again in a few minutes.";
export const CLOUD_COMPUTER_CAPPED =
  "This bot's cloud computer isn't responding, and it was already replaced once in the last hour, so MausBot stopped replacing it. Do not retry computer work in this turn; tell the person.";
/** Automatic replacement is off: the person decides, from the computer panel. */
export const CLOUD_COMPUTER_NEEDS_PERSON =
  "This bot's cloud computer isn't responding. The person can replace it from the computer panel. Do not retry computer work in this turn; tell the person.";
/** A team's shared computer is never restarted or deleted by itself: every teammate's work is on it. */
export const CLOUD_COMPUTER_TEAM_NOT_RESPONDING =
  "This team's shared cloud computer isn't responding. A team admin can delete it in Settings → Desktops & browser → Desktops and create it again from the Team map. Do not retry computer work in this turn; tell the person.";
/** The provider says the machine is gone, but not yet for long enough to delete it by itself. */
export const CLOUD_COMPUTER_DEAD_WAITING =
  "This bot's cloud computer isn't responding. MausBot replaces it if it is still down in half an hour; the person can replace it now from the computer panel. Do not retry computer work in this turn; tell the person.";
/** One command got no answer; the computer is not judged on one. */
export const CLOUD_COMPUTER_NO_ANSWER =
  "The cloud computer did not answer this call, so it may not have run. Take a fresh screenshot in a moment before repeating it.";

/** The call was sent again until its time ran out and no copy of it is known to have run. */
export const CLOUD_COMPUTER_STILL_WAKING =
  "The cloud computer is awake but not answering yet, so this call got no answer and most likely did not run. Try again in a minute, and take a fresh screenshot first.";
export const CLOUD_COMPUTER_STILL_RESTORING =
  "The cloud computer is still restoring its disk after waking, so this call got no answer and most likely did not run. Try again in a minute, and take a fresh screenshot first.";
/** The call ran on the computer, once, but its answer never came back. */
export const CLOUD_COMPUTER_ANSWER_LOST =
  "The cloud computer ran this call, but its answer was lost on the way back. It was not run a second time. Take a fresh screenshot to see what it did before repeating it.";
export const CLOUD_COMPUTER_EXEC_ANSWER_LOST =
  "The cloud computer started this command, but its answer was lost on the way back, so it may still be running or may have finished. It was not "
  + "started a second time. Do not run it again blindly: check first, for example with exec `pgrep -af '<part of the command>'` or by looking at the files it writes.";

/** Why an unattended run did not start because of its cloud computer, and the note on one that finished unsure of it. A
 * scheduled run that met `noWake` is tried again a few times first (server/routine-wake-retry.ts). */
export const RUN_COMPUTER_LINES = {
  waking: "Waiting for its cloud computer to wake and answer",
  noWake: "The cloud computer did not wake, so this run did not start. The next scheduled run tries again.",
  wakeRefused: "The cloud computer did not wake because its provider refused to start it, so this run did not start. The next scheduled run tries again.",
  noAnswer: "The cloud computer did not answer in time, so this run did not start. The next scheduled run tries again.",
  afterRestart: "The cloud computer did not answer after a restart, so this run did not start. The next scheduled run tries again; Restart computer or Replace computer in the computer panel fixes it sooner.",
  personBusy: "The cloud computer is not answering, and it was not restarted because someone is using it, so this run did not start. The next scheduled run tries again.",
  restartLimited: "The cloud computer is not answering, and it was already restarted within the last hour, so this run did not start. The next scheduled run tries again.",
  shared: "The team's shared cloud computer is not answering, so this run did not start. A team admin can look at it in the Team map.",
  diskStillFull: "This run started with its cloud computer's disk still almost full, after MausBot removed what it safely could. Check that what the run did is complete, and free space on the computer.",
  lastCallUnanswered: "This run finished, but its last cloud computer call got no answer, so check that what it did on the computer is complete. It was not run again.",
} as const;

/** The person's one line in the chat and the Inbox, by its language pack key; each takes the bot's `{name}`. */
export const CLOUD_COMPUTER_PERSON_LINES = {
  replaced: "server.cloudComputer.replaced",
  setAside: "server.cloudComputer.setAside",
  noRoom: "server.cloudComputer.noRoom",
  restarted: "server.cloudComputer.restarted",
  capped: "server.cloudComputer.capped",
  unreachable: "server.cloudComputer.unreachable",
  needsPerson: "server.cloudComputer.needsPerson",
  teamNotResponding: "server.cloudComputer.teamNotResponding",
} as const;
export type CloudComputerPersonLine = keyof typeof CLOUD_COMPUTER_PERSON_LINES;
