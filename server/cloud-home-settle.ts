// Settles a Cloud home's people before anything is served or any routine runs: who the owner is (cloud-owner.ts),
// which routines a bot made from outside, which an earlier version left nobody's, and whether anyone but the owner has
// ever used it (cloud-sharing.ts).
import type { createCloudRoutineAuthors } from "./cloud-lending.ts";
import { recordCloudSharing, settleCloudOwnership, type CloudOwnership, type CloudOwnershipOptions } from "./cloud-owner.ts";
import { approvalShape, createdShape, ownersRoutinesMadeInChat, routinesKeptAtSharing, type OwnersRoutinesInput } from "./cloud-routine-level.ts";
import { CLOUD_OUTSIDE_KEY, cloudShared } from "./cloud-sharing.ts";
import type { asSchedule } from "./routine-requests.ts";
import type { RoutineManager } from "./routines.ts";
import type { Message, Store } from "./store.ts";
import type { ThreadStarters } from "./thread-starters.ts";

export interface CloudHomeSettleDeps {
  file: string;
  machineId: string;
  ownerKey: string;
  nobodyKey: string;
  sessions: CloudOwnershipOptions["sessions"];
  personKey: CloudOwnershipOptions["personKey"];
  starters: ThreadStarters;
  authors: ReturnType<typeof createCloudRoutineAuthors>;
  routines: () => RoutineManager | null;
  store: Pick<Store, "bots" | "tasks" | "groups" | "messagesFor" | "botByThread" | "groupByThread" | "unpinTaskCwd">;
  linePersonKey(line: Message): string | undefined;
  asSchedule: typeof asSchedule;
  restoredNow?: string;
  lastRestore?: string;
  /** Runs as soon as earlier owners are settled, before anything below asks who the owner is. */
  settled(ownership: CloudOwnership): void;
  /** Proven the owner's, as lending and memory require. */
  provenPerson(person: string | undefined): boolean;
  /** The owner's key, a current admin device's, or a marker that names no person. */
  ownersOrNone(key: string): boolean;
  threadStarters(threadId: string): (string | undefined)[];
  cardAnswerer(card: NonNullable<Message["card"]>): string | undefined;
  reportFromOthers(line: Message): boolean;
  /** Records the owner's fingerprint and key on a routine. */
  ownersRoutine(routineId: string): void;
  log(line: string): void;
}

export function settleCloudHome(deps: CloudHomeSettleDeps): { solo(): boolean; share(): void } {
  const { authors, store } = deps;
  const routineById = (id: string) => deps.routines()?.listRoutines().find((routine) => routine.id === id);
  const shapeOf = (id: string) => { const routine = routineById(id); return routine ? approvalShape(routine) : undefined; };
  const thread = (threadId: string) => store.botByThread(threadId) || store.groupByThread(threadId) ? store.messagesFor(threadId) : [];
  const webhookRuns = new Set((deps.routines()?.listRuns() ?? []).flatMap((run) => run.triggerSource === "webhook" && run.threadId ? [run.threadId] : []));
  const outsideThread = (threadId: string, lines: readonly Message[] = thread(threadId)) => webhookRuns.has(threadId) || lines.some((line) => line.webhookPost);
  /** Every conversation once: who wrote and answered, the owner's card approvals, and the routines a webhook-driven conversation made or changed. */
  const search = () => {
    const senders = new Set<string>(), answerers = new Set<string>(), outside = new Set<string>();
    const approvals: Array<[string, string, string]> = [];
    for (const threadId of new Set([...store.bots.flatMap((bot) => store.tasks(bot.id).map((task) => task.threadId)), ...store.groups.map((group) => group.threadId)])) {
      const lines = store.messagesFor(threadId);
      const driven = outsideThread(threadId, lines);
      for (const line of lines) {
        const sender = deps.linePersonKey(line);
        if (sender) senders.add(sender);
        const answerer = line.card?.answeredBy?.kind === "session" ? line.card.answeredBy.person : undefined;
        if (answerer) answerers.add(answerer);
        const request = line.card?.answered === "allow" ? line.card.routineRequest : undefined;
        const created = request?.resultId ? createdShape(line, deps.asSchedule) : undefined;
        if (answerer && created) approvals.push([request!.resultId!, answerer, created]);
        const changed = request?.operation.action === "create" ? request.resultId : request?.operation.action === "update" ? request.operation.routineId : undefined;
        if (driven && changed) outside.add(changed);
      }
    }
    return { senders, answerers, approvals, outside };
  };
  let searched: ReturnType<typeof search> | undefined;
  const ownership = settleCloudOwnership({
    file: deps.file, machineId: deps.machineId, ownerKey: deps.ownerKey, nobodyKey: deps.nobodyKey, outsideKey: CLOUD_OUTSIDE_KEY,
    sessions: deps.sessions, personKey: deps.personKey, starters: deps.starters, writers: authors,
    routines: {
      ids: () => (deps.routines()?.listRoutines() ?? []).map((routine) => routine.id),
      writer: (id) => authors.writer(id),
      fingerprinted: (id) => { const routine = routineById(id); return Boolean(routine) && authors.authored(id, routine!); },
      resultsOpener: (id) => { const results = routineById(id)?.resultsThreadId; return results ? deps.starters.get(results) : undefined; },
      shape: shapeOf,
      name: (id, person) => authors.wrote(id, person),
      pause: (ids) => { for (const id of ids) deps.routines()?.update(id, { enabled: false }); },
    },
    unpin: (threadIds) => { for (const threadId of threadIds) store.unpinTaskCwd(threadId); },
    lines: () => (searched ??= search()),
    ...(deps.restoredNow ? { restoredNow: deps.restoredNow } : {}),
    ...(deps.lastRestore ? { lastRestore: deps.lastRestore } : {}),
    log: deps.log,
  });
  deps.settled(ownership);

  // Once per machine, and after a restore, while the Cloud is not known to be shared.
  const found = ownership.sharedSince === undefined && (!ownership.soloBefore || ownership.restoring) ? (searched ??= search()) : undefined;
  for (const id of found?.outside ?? []) if (authors.writer(id) !== deps.ownerKey && authors.writer(id) !== CLOUD_OUTSIDE_KEY) authors.wrote(id, CLOUD_OUTSIDE_KEY);
  const level: OwnersRoutinesInput = {
    routines: deps.routines()?.listRoutines() ?? [], nobodyKey: deps.nobodyKey, writer: authors.writer, recorded: authors.recorded, thread,
    starters: deps.threadStarters, ownerPerson: deps.provenPerson, reportFromOthers: deps.reportFromOthers, cardAnswerer: deps.cardAnswerer,
    shape: shapeOf, cardShape: (line) => createdShape(line, deps.asSchedule),
  };
  for (const { id, proven } of ownersRoutinesMadeInChat(level)) {
    if (proven) deps.ownersRoutine(id); else authors.wrote(id, deps.ownerKey);
  }

  const record = { file: deps.file, machineId: deps.machineId, log: deps.log };
  const keep = () => {
    for (const id of routinesKeptAtSharing({ ...level, routines: deps.routines()?.listRoutines() ?? [], outsideThread: (threadId) => outsideThread(threadId) })) {
      authors.wrote(id, deps.ownerKey);
    }
  };
  let solo = !cloudShared({ ownership, ownersOrNone: deps.ownersOrNone, recorded: [...deps.starters.people(), ...authors.people()],
    ...(found ? { seen: [...found.senders, ...found.answerers] } : {}) });
  if (!solo && ownership.sharedSince === undefined) {
    // Someone but the owner first appeared since a start that found only the owner: what exists now was made by the owner alone.
    if (ownership.soloBefore && !ownership.restoring) keep();
    recordCloudSharing(record, { sharedSince: Date.now() });
    deps.log("cloud home: someone besides the owner has used this Cloud, so what they or a webhook start runs confined from now on");
  } else if (solo && found) {
    recordCloudSharing(record, { peopleChecked: true });
  }
  return {
    solo: () => solo,
    share: () => {
      if (!solo) return;
      keep();
      recordCloudSharing(record, { sharedSince: Date.now() });
      solo = false;
    },
  };
}
