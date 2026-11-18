// A Claude process started before its conversation's first message (ProviderAdapter.prestart) connects its tool servers
// at once. Some of OpenMausBot's own servers answer `tools/list` by asking the harness with the conversation's bearer, and
// the harness honours a bearer only while a turn runs, so that process lists nothing from them. Before the first turn
// takes the process it asks the CLI to connect those servers again ({type:"control_request", request:{subtype:
// "mcp_reconnect", serverName}}, answered once the server is connected and listed; Claude Code 2.1.321), now that the turn
// stands. A CLI that does not know the request cannot be started ahead at all.

/** The tool servers that list through the harness (harness-mcp-proxy.ts). */
const LISTED_BY_HARNESS = new Set(["browser", "computer", "data", "email", "device"]);
const ID_PREFIX = "prestart-tools-";
const RECONNECT_WAIT_MS = 3_000;

export function claudePrestartTools() {
  let unsupported = false;
  let sent = 0;
  return {
    /** False once a CLI refused the request: nothing more is started ahead on this engine until the server restarts. */
    get usable(): boolean { return !unsupported; },
    /** One process's requests. `write` settles true once the frame reached the CLI's stdin. */
    forProcess(write: (frame: unknown) => Promise<boolean>, waitMs: number = RECONNECT_WAIT_MS) {
      const pending = new Map<string, (ok: boolean) => void>();
      const ask = (serverName: string): Promise<boolean> => new Promise((resolve) => {
        const id = `${ID_PREFIX}${++sent}`;
        const timer = setTimeout(() => settle(id, false), waitMs);
        timer.unref?.();
        pending.set(id, (ok) => { clearTimeout(timer); resolve(ok); });
        void write({ type: "control_request", request_id: id, request: { subtype: "mcp_reconnect", serverName } }).then((delivered) => { if (!delivered) settle(id, false); });
      });
      const settle = (id: string, ok: boolean) => {
        const resolve = pending.get(id);
        pending.delete(id);
        resolve?.(ok);
      };
      return {
        /** Consumes every answer to its own requests; false for every other frame. */
        frame(o: any): boolean {
          const id = o?.type === "control_response" ? o.response?.request_id : undefined;
          if (typeof id !== "string" || !id.startsWith(ID_PREFIX)) return false;
          if (o.response.subtype !== "success" && o.response.error_code === "unsupported_request") unsupported = true;
          settle(id, o.response.subtype === "success");
          return true;
        },
        /** True once every server of `mounted` that lists through the harness is connected again; false when one could
         * not be, and the process must not be used. */
        async relist(mounted: readonly string[]): Promise<boolean> {
          const answers = await Promise.all(mounted.filter((name) => LISTED_BY_HARNESS.has(name)).map(ask));
          return answers.every(Boolean);
        },
        close(): void {
          for (const id of pending.keys()) settle(id, false);
        },
      };
    },
  };
}
export type ClaudePrestartTools = ReturnType<ReturnType<typeof claudePrestartTools>["forProcess"]>;
