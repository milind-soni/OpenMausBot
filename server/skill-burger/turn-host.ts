// The server's own parts a Skill Burger run needs, gathered once at boot: the turn's folder, a capability of another kind
// for the same turn (so an app step meets the connectors gate and a page the browser's), and the chat's event bus.
import { randomUUID } from "node:crypto";

import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import type { BurgerTurn, StepEvent } from "./runs.ts";

/** The calling turn, as the agents capability names it. */
export interface CallingTurn { botId: string; threadId: string; generation: string; [field: string]: unknown }

export interface BurgerHostDeps {
  port: number;
  cwd(botId: string, threadId: string): string;
  /** A bearer of `kind` for the same turn. */
  mint(turn: CallingTurn, kind: "connectors" | "computer"): string;
  /** The bot's browser for this turn, as the turn's browser tools would get it; null while it has none. */
  browser(turn: CallingTurn): Promise<{ env?: Record<string, string | undefined> } | null>;
  /** The chat's event bus, with the engine of the turn that is running in the thread. */
  publish(threadId: string, event: Record<string, unknown>): void;
  mayEditEveryChat(): boolean;
}

/** The run's view of the calling turn: `authorization` is the agents bearer the tool call came with. */
export function burgerTurn(host: BurgerHostDeps, turn: CallingTurn, authorization: string | undefined): BurgerTurn {
  const post = async (path: string, token: string, body: unknown, signal: AbortSignal) => {
    try {
      const res = await fetch(`http://127.0.0.1:${host.port}${path}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal,
      });
      const parsed = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { ok: res.ok && !parsed.error, body: parsed };
    } catch (error) {
      return { ok: false, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  };
  return {
    botId: turn.botId,
    threadId: turn.threadId,
    cwd: host.cwd(turn.botId, turn.threadId),
    mayEditEveryChat: host.mayEditEveryChat(),
    publish: (event: StepEvent) => host.publish(turn.threadId, { eventId: randomUUID(), createdAt: new Date().toISOString(), threadId: turn.threadId, itemType: "tool", ...event }),
    async internal(kind, path, body, signal) {
      if (kind === "agents") {
        const bearer = authorization?.replace(/^Bearer\s+/i, "") ?? "";
        return bearer ? post(path, bearer, body, signal) : { ok: false, body: { error: "this run has no capability" } };
      }
      if (kind === "browser") {
        const browser = await host.browser(turn).catch(() => null);
        const token = browser?.env?.[harnessMcpTokenEnv("browser")];
        return token ? post(path, token, body, signal) : { ok: false, body: { error: "this bot's browser isn't available" } };
      }
      return post(path, host.mint(turn, kind), body, signal);
    },
  };
}
