import type { Readable, Writable } from "node:stream";

/** One CDP connection's bytes: a launched Chrome's pipe, a WebSocket, or the desktop link. */
export interface CdpTransport {
  send(message: string): void;
  onMessage(listener: (message: string) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(): void;
}

class Listeners {
  readonly messages = new Set<(message: string) => void>();
  readonly closes = new Set<(reason: string) => void>();
  #closeReason: string | null = null;

  get closed(): boolean {
    return this.#closeReason !== null;
  }

  message(text: string): void {
    for (const listener of this.messages) {
      try { listener(text); } catch {}
    }
  }

  close(reason: string): void {
    if (this.#closeReason !== null) return;
    this.#closeReason = reason;
    for (const listener of this.closes) {
      try { listener(reason); } catch {}
    }
  }

  onClose(listener: (reason: string) => void): void {
    if (this.#closeReason !== null) listener(this.#closeReason);
    else this.closes.add(listener);
  }
}

/** Chrome's --remote-debugging-pipe: JSON messages separated by NUL, written to fd 3 and read from fd 4. */
export function pipeTransport(writable: Writable, readable: Readable): CdpTransport {
  const listeners = new Listeners();
  let pending: Buffer[] = [];
  readable.on("data", (chunk: Buffer) => {
    let start = 0;
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      pending.push(chunk.subarray(start, end));
      const text = Buffer.concat(pending).toString("utf8");
      pending = [];
      start = end + 1;
      if (text) listeners.message(text);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  });
  readable.on("end", () => listeners.close("the browser closed its pipe"));
  readable.on("close", () => listeners.close("the browser closed its pipe"));
  readable.on("error", (error) => listeners.close(error.message));
  writable.on("error", (error) => listeners.close(error.message));
  return {
    send(message) {
      if (listeners.closed) return;
      writable.write(`${message}\0`);
    },
    onMessage(listener) {
      listeners.messages.add(listener);
    },
    onClose(listener) {
      listeners.onClose(listener);
    },
    close() {
      listeners.close("closed by the driver");
      writable.end();
      readable.destroy();
    },
  };
}

/** A browser's DevTools WebSocket, for a Chrome OMB did not launch (the person's own, or a cloud browser). */
export function webSocketTransport(url: string, { timeoutMs = 15_000 }: { timeoutMs?: number } = {}): Promise<CdpTransport> {
  if (!/^wss?:\/\//i.test(url)) return Promise.reject(new Error(`Not a DevTools WebSocket address: ${url}`));
  const socket = new WebSocket(url);
  const listeners = new Listeners();
  return new Promise<CdpTransport>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The browser at ${new URL(url).host} did not accept a DevTools connection within ${timeoutMs} ms.`));
      socket.close();
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        send(message) {
          if (!listeners.closed && socket.readyState === WebSocket.OPEN) socket.send(message);
        },
        onMessage(listener) {
          listeners.messages.add(listener);
        },
        onClose(listener) {
          listeners.onClose(listener);
        },
        close() {
          listeners.close("closed by the driver");
          socket.close();
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const data: unknown = event.data;
      listeners.message(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Could not open a DevTools connection to ${new URL(url).host}.`));
      listeners.close("the DevTools connection failed");
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      listeners.close(`the DevTools connection closed (${event.code})`);
    });
  });
}

export interface SentCommand {
  method: string;
  sessionId: string | null;
  params: Readonly<Record<string, unknown>>;
}

/** Records every command as it leaves for the browser, below the driver's own guard. */
export function tracingTransport(inner: CdpTransport, record: (sent: SentCommand) => void): CdpTransport {
  return {
    send(message) {
      try {
        const parsed = JSON.parse(message) as { method?: unknown; sessionId?: unknown; params?: unknown };
        if (typeof parsed.method === "string") {
          record({
            method: parsed.method,
            sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
            params: parsed.params && typeof parsed.params === "object" ? parsed.params as Record<string, unknown> : {},
          });
        }
      } catch {}
      inner.send(message);
    },
    onMessage: (listener) => inner.onMessage(listener),
    onClose: (listener) => inner.onClose(listener),
    close: () => inner.close(),
  };
}
