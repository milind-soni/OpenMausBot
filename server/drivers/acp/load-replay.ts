import type { AcpLink } from "./host.ts";

/** Sends a session/load and settles with its answer or, given `quietMs`, once the agent has replayed updates of
 * `sessionId` and then sent none for that long, for an agent that can leave the load unanswered after its replay. A load
 * that replays nothing waits for its answer, up to the request's own timeout. `receive` hears the answer, or `replayed()`
 * when the replay went quiet first; a later answer or failure is dropped. */
export function loadUntilReplayQuiet(load: {
  link: Pick<AcpLink, "onUpdate">;
  sessionId: string;
  quietMs: number | undefined;
  send: (receive: (result: any) => void) => Promise<unknown>;
  receive: (result: any) => void;
  replayed: () => any;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      if (load.link.onUpdate === heard) load.link.onUpdate = null;
    };
    const heard = (params: any) => {
      if (settled || params?.sessionId !== load.sessionId) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish();
        load.receive(load.replayed());
        resolve();
      }, load.quietMs);
    };
    if (load.quietMs) load.link.onUpdate = heard;
    load.send((result) => { if (!settled) load.receive(result); }).then(
      () => { if (!settled) { finish(); resolve(); } },
      (error) => { if (!settled) { finish(); reject(error); } },
    );
  });
}
