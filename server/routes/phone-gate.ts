import type { ServerResponse } from "node:http";

import { CONTROL_WAIT_MS } from "../control-client.ts";
import type { json } from "../harness/http.ts";
import type { PhoneHold } from "../phone-screen/hold.ts";
import type { TurnOwner, TurnResources } from "../turn-resources.ts";
import { PASS } from "./table.ts";

const PHONE = "computer:phone";

export interface PhoneGateContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof json;
  turn: TurnOwner;
  requireActive: () => void;
  /** The claim's JSON body. `{ "wait": false }` comes from the middle of a tool call, which cannot wait for a person. */
  readBody: () => Promise<unknown>;
  /** Aborts when the bot's request is gone. */
  signal: AbortSignal;
}

export function createPhoneGate(deps: {
  enabled: () => boolean;
  hold: Pick<PhoneHold, "held" | "wait">;
  resources: Pick<TurnResources, "holder">;
  claim: (owner: TurnOwner, resource: string) => boolean;
}) {
  let handedBackTo: Pick<TurnOwner, "threadId" | "generation"> | undefined;
  const takeHandBack = (turn: TurnOwner): boolean => {
    if (handedBackTo?.threadId !== turn.threadId || handedBackTo.generation !== turn.generation) return false;
    handedBackTo = undefined;
    return true;
  };

  return {
    /** For the hold's `onChange`: the turn that has the phone when a person's hold ends must read the screen again before it acts. */
    holdChanged(held: boolean): void {
      if (held) return;
      const holder = deps.resources.holder(PHONE);
      handedBackTo = holder && { threadId: holder.threadId, generation: holder.generation };
    },

    async internal(ctx: PhoneGateContext): Promise<typeof PASS | void> {
      if (ctx.method !== "POST" || ctx.path !== "/api/internal/phone/claim") return PASS;
      ctx.requireActive();
      if (deps.enabled()) {
        const midCall = ((await ctx.readBody()) as { wait?: unknown } | null)?.wait === false;
        const waited = midCall && deps.hold.held ? "held" : await deps.hold.wait(ctx.signal, CONTROL_WAIT_MS);
        if (waited === "held") return ctx.json(ctx.res, 423, { reason: "person" });
        if (waited === "handed-back") {
          takeHandBack(ctx.turn);
          return ctx.json(ctx.res, 423, { reason: "handed-back" });
        }
        ctx.requireActive();
        if (takeHandBack(ctx.turn)) return ctx.json(ctx.res, 423, { reason: "handed-back" });
      }
      if (!deps.claim(ctx.turn, PHONE)) return ctx.json(ctx.res, 409, { error: "another thread is using the phone" });
      return ctx.json(ctx.res, 200, { claimed: true });
    },
  };
}
