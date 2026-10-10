import type { ApiClient } from "./api-types.ts";

export interface ApiResponse {
  status: number;
  body: any;
}

export async function makeClient(base: string): Promise<ApiClient> {
  const request = async (method: string, path: string, body?: unknown): Promise<ApiResponse> => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    put: (path, body) => request("PUT", path, body),
    del: (path) => request("DELETE", path),
  };
}

/** One read, bounded by the wait's own deadline: a request that connects
 * but never completes would otherwise park the loop forever and the
 * deadline check below would never run. */
async function readWithDeadline<T>(read: () => Promise<T>, what: string, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(what + " timed out: a read never completed")),
          Math.max(deadline - Date.now(), 1),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls read() until accept() holds. All eval waits are state-based:
 * no scenario ever passes or fails on a sleep. */
export async function waitUntil<T>(
  what: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await readWithDeadline(read, what, deadline);
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(what + " (waited " + timeoutMs + "ms); last value: " + JSON.stringify(value));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
