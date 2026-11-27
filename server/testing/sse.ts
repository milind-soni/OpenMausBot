// SSE reader for API tests: collect /api/events frames and await predicates instead of sleeping.
export interface SseRecorder {
  frames: any[];
  /** Resolves with the first frame matching `pred`, already-seen ones
   * included. Rejects after `timeoutMs` with what did arrive. */
  until(pred: (frame: any) => boolean, timeoutMs?: number): Promise<any>;
  close(): void;
}

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseRecorder> {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: controller.signal });
  if (!res.ok || !res.body) {
    controller.abort();
    throw new Error(`SSE connect failed: ${res.status}`);
  }

  const frames: any[] = [];
  const waiters: Array<{
    pred: (frame: any) => boolean;
    resolve: (frame: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let closed = false;
  const finish = (error: Error) => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finish(new Error("SSE stream closed before a matching frame arrived"));
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        // frames are separated by a blank line; keepalives are comments
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = chunk.split("\n").find((line) => line.startsWith("data: "));
          if (!data) continue;
          let frame: unknown;
          try {
            frame = JSON.parse(data.slice(6));
          } catch {
            continue;
          }
          frames.push(frame);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (!waiters[i].pred(frame)) continue;
            const waiter = waiters.splice(i, 1)[0];
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          }
        }
      }
    } catch (error) {
      if (!closed) finish(error instanceof Error ? error : new Error("SSE stream read failed"));
    }
  })();

  return {
    frames,
    until(pred, timeoutMs = 10_000) {
      const seen = frames.find(pred);
      if (seen) return Promise.resolve(seen);
      if (closed) return Promise.reject(new Error("SSE stream closed before a matching frame arrived"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(
            new Error(
              `no matching frame within ${timeoutMs}ms; saw: ${frames.map((f) => f?.kind).join(", ") || "(none)"}`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        const waiter = { pred, resolve, reject, timer };
        waiters.push(waiter);
      });
    },
    close: () => {
      if (closed) return;
      finish(new Error("SSE stream closed before a matching frame arrived"));
      controller.abort();
    },
  };
}
