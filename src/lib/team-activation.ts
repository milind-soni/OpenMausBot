/** One /api/teams/active at a time, in click order. Each click gets an
 *  operation id so a repeated pick of the same team cannot be applied or
 *  rolled back by an earlier request. A superseded click is not sent at
 *  all, so creating or importing a team can enqueue as the last write and
 *  a slower earlier switch cannot land on the server after it. Rollback
 *  uses the last team the server actually accepted, not an optimistic
 *  in-between click. */

export interface TeamActivationQueue {
  enqueue: (requestedTeamId: string | null, baselineTeamId: string | null) => Promise<void>;
  isBusy: () => boolean;
}

export interface TeamActivationQueueOptions<T> {
  request: (teamId: string | null) => Promise<T>;
  apply: (result: T) => void;
  rollback: (teamId: string | null) => void;
  onError: (error: Error) => void;
}

export function createTeamActivationQueue<T>(opts: TeamActivationQueueOptions<T>): TeamActivationQueue {
  let tail: Promise<void> = Promise.resolve();
  let latestOp = 0;
  let pending = 0;
  let confirmedTeamId: string | null = null;
  let hasConfirmed = false;

  const run = async (opId: number, requestedTeamId: string | null) => {
    if (opId !== latestOp) return;
    try {
      const result = await opts.request(requestedTeamId);
      confirmedTeamId = requestedTeamId;
      hasConfirmed = true;
      if (opId !== latestOp) return;
      opts.apply(result);
    } catch (caught) {
      if (opId !== latestOp) return;
      opts.onError(caught instanceof Error ? caught : new Error(String(caught)));
      opts.rollback(confirmedTeamId);
    }
  };

  return {
    enqueue(requestedTeamId: string | null, baselineTeamId: string | null) {
      const opId = ++latestOp;
      pending++;
      if (!hasConfirmed) {
        confirmedTeamId = baselineTeamId;
        hasConfirmed = true;
      }
      const job = () => run(opId, requestedTeamId);
      const next = tail.then(job, job).finally(() => {
        pending--;
      });
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    isBusy() {
      return pending > 0;
    },
  };
}
