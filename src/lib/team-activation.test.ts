import { describe, expect, it, vi } from "vitest";

import { createTeamActivationQueue } from "./team-activation";

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_reason: Error) => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Result {
  activeTeamId: string | null;
}

function makeQueue(request: (teamId: string | null) => Promise<Result>) {
  let current: string | null = null;
  const applied: Array<string | null> = [];
  const rolledBack: Array<string | null> = [];
  const errors: Error[] = [];
  const queue = createTeamActivationQueue<Result>({
    request,
    apply: (result) => {
      current = result.activeTeamId;
      applied.push(result.activeTeamId);
    },
    rollback: (rollbackTeamId) => {
      current = rollbackTeamId;
      rolledBack.push(rollbackTeamId);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return {
    queue,
    setCurrent: (teamId: string | null) => {
      current = teamId;
    },
    get current() {
      return current;
    },
    applied,
    rolledBack,
    errors,
  };
}

describe("team activation queue", () => {
  it("sends switches in click order so a slower first request cannot win on the server", async () => {
    const started: Array<string | null> = [];
    const inflight: Array<{ id: string | null; wait: ReturnType<typeof deferred<void>> }> = [];
    let server: string | null = "all";
    const { queue, setCurrent, applied } = makeQueue((id) => {
      started.push(id);
      const wait = deferred<void>();
      inflight.push({ id, wait });
      return wait.promise.then(() => {
        server = id;
        return { activeTeamId: id };
      });
    });

    setCurrent("eng");
    const first = queue.enqueue("eng", "all");
    await Promise.resolve();
    expect(started).toEqual(["eng"]);
    expect(inflight).toHaveLength(1);

    setCurrent("mkt");
    const second = queue.enqueue("mkt", "eng");
    inflight[0]!.wait.resolve();
    await first;
    await Promise.resolve();
    expect(started).toEqual(["eng", "mkt"]);
    inflight[1]!.wait.resolve();
    await second;

    expect(server).toBe("mkt");
    expect(applied).toEqual(["mkt"]);
  });

  it("does not send a queued switch that a later click already superseded", async () => {
    const started: Array<string | null> = [];
    const inflight: Array<{ id: string | null; wait: ReturnType<typeof deferred<void>> }> = [];
    let server: string | null = "all";
    const { queue, setCurrent, applied } = makeQueue((id) => {
      started.push(id);
      const wait = deferred<void>();
      inflight.push({ id, wait });
      return wait.promise.then(() => {
        server = id;
        return { activeTeamId: id };
      });
    });

    setCurrent("eng");
    const first = queue.enqueue("eng", "all");
    await Promise.resolve();
    expect(started).toEqual(["eng"]);

    setCurrent("mkt");
    const second = queue.enqueue("mkt", "eng");
    setCurrent("ops");
    const third = queue.enqueue("ops", "mkt");

    inflight[0]!.wait.resolve();
    await first;
    await second;
    await Promise.resolve();
    expect(started).toEqual(["eng", "ops"]);
    inflight[1]!.wait.resolve();
    await third;

    expect(server).toBe("ops");
    expect(applied).toEqual(["ops"]);
  });

  it("only sends the latest switch when several clicks land before the first request starts", async () => {
    const started: Array<string | null> = [];
    const inflight: Array<{ id: string | null; wait: ReturnType<typeof deferred<void>> }> = [];
    let server: string | null = "all";
    const { queue, setCurrent, applied } = makeQueue((id) => {
      started.push(id);
      const wait = deferred<void>();
      inflight.push({ id, wait });
      return wait.promise.then(() => {
        server = id;
        return { activeTeamId: id };
      });
    });

    setCurrent("eng");
    const first = queue.enqueue("eng", "all");
    setCurrent("mkt");
    const second = queue.enqueue("mkt", "eng");
    setCurrent("ops");
    const third = queue.enqueue("ops", "mkt");

    await first;
    await second;
    await Promise.resolve();
    expect(started).toEqual(["ops"]);
    inflight[0]!.wait.resolve();
    await third;

    expect(server).toBe("ops");
    expect(applied).toEqual(["ops"]);
  });

  it("is busy until every queued switch has settled", async () => {
    const wait = deferred<Result>();
    const queue = createTeamActivationQueue<Result>({
      request: () => wait.promise,
      apply: () => {},
      rollback: () => {},
      onError: () => {},
    });

    expect(queue.isBusy()).toBe(false);
    const job = queue.enqueue("eng", null);
    expect(queue.isBusy()).toBe(true);
    wait.resolve({ activeTeamId: "eng" });
    await job;
    expect(queue.isBusy()).toBe(false);
  });

  it("rolls a failed later switch back to the last confirmed team, not an optimistic one", async () => {
    const started: Array<string | null> = [];
    const inflight: Array<{ id: string | null; wait: ReturnType<typeof deferred<void>> }> = [];
    const harness = makeQueue((id) => {
      started.push(id);
      const wait = deferred<void>();
      inflight.push({ id, wait });
      return wait.promise.then(() => {
        throw new Error(`${id} failed`);
      });
    });
    const { queue, setCurrent, applied, rolledBack, errors } = harness;

    setCurrent("eng");
    const first = queue.enqueue("eng", null);
    await Promise.resolve();
    expect(started).toEqual(["eng"]);

    setCurrent("mkt");
    const second = queue.enqueue("mkt", "eng");
    inflight[0]!.wait.resolve();
    await first;
    expect(applied).toEqual([]);
    expect(rolledBack).toEqual([]);
    expect(errors).toEqual([]);

    await Promise.resolve();
    expect(started).toEqual(["eng", "mkt"]);
    inflight[1]!.wait.resolve();
    await second;
    expect(errors).toHaveLength(1);
    expect(rolledBack).toEqual([null]);
    expect(harness.current).toBeNull();
  });

  it("does not let a failed first A rewind A → All bots → A", async () => {
    const inflight: Array<{ id: string | null; wait: ReturnType<typeof deferred<void>> }> = [];
    let server: string | null = null;
    let calls = 0;
    const harness = makeQueue((id) => {
      const wait = deferred<void>();
      const call = ++calls;
      inflight.push({ id, wait });
      return wait.promise.then(() => {
        if (call === 1) throw new Error("first A failed");
        server = id;
        return { activeTeamId: id };
      });
    });
    const { queue, setCurrent, applied, rolledBack, errors } = harness;

    setCurrent("eng");
    const first = queue.enqueue("eng", null);
    await Promise.resolve();
    setCurrent(null);
    const allBots = queue.enqueue(null, "eng");
    setCurrent("eng");
    const again = queue.enqueue("eng", null);

    inflight[0]!.wait.resolve();
    await first;
    expect(rolledBack).toEqual([]);
    expect(errors).toEqual([]);

    await allBots;
    await Promise.resolve();
    inflight[1]!.wait.resolve();
    await again;

    expect(server).toBe("eng");
    expect(harness.current).toBe("eng");
    expect(applied).toEqual(["eng"]);
    expect(rolledBack).toEqual([]);
  });

  it("keeps a later confirmed switch when an earlier request fails", async () => {
    const onError = vi.fn();
    let current: string | null = "eng";
    const first = deferred<Result>();
    const second = deferred<Result>();
    const requests: Array<string | null> = [];
    const queue = createTeamActivationQueue<Result>({
      request: (id) => {
        requests.push(id);
        return id === "eng" ? first.promise : second.promise;
      },
      apply: (result) => {
        current = result.activeTeamId;
      },
      rollback: (rollbackTeamId) => {
        current = rollbackTeamId;
      },
      onError,
    });

    const firstJob = queue.enqueue("eng", null);
    await Promise.resolve();
    current = "mkt";
    const secondJob = queue.enqueue("mkt", "eng");

    first.reject(new Error("eng failed"));
    await firstJob;
    expect(onError).not.toHaveBeenCalled();
    expect(current).toBe("mkt");

    second.resolve({ activeTeamId: "mkt" });
    await secondJob;
    expect(current).toBe("mkt");
    expect(requests).toEqual(["eng", "mkt"]);
  });
});
