import type { ServerResponse } from "node:http";

import type { DecisionRow } from "../decision-log.ts";
import { createEduBrains, type EduConfig } from "../edu-brain.ts";
import { createEduCloud, EDU_CLOUD_RELAY_PATH, sendRelayed, type EduCloudDeps } from "../edu-cloud.ts";
import { createEduCrew, type EduCrewDeps } from "../edu-crew.ts";
import { createEduProposals, type EduProposalDeps, type EduProposals } from "../edu-proposals.ts";
import { PASS } from "../routes/table.ts";

export interface EduHostDeps {
  dataDir: string;
  desktop: boolean;
  config(): EduConfig | undefined;
  hostLocal(): boolean;
  store: EduProposalDeps["store"] & EduCrewDeps["store"];
  bus: NonNullable<EduProposalDeps["bus"]>;
  inRoom(threadId: string): boolean;
  decide(row: Omit<DecisionRow, "at">): void;
  token: EduCloudDeps["token"];
  relay: NonNullable<EduCloudDeps["relay"]>;
  crew: Pick<EduCrewDeps, "folder" | "engine" | "turn">;
}

interface InternalContext {
  method: string;
  path: string;
  req: { headers: Record<string, string | string[] | undefined> };
  res: ServerResponse;
  json(res: ServerResponse, status: number, body: unknown): void;
  botId: string;
  threadId: string;
  readBody(): Promise<unknown>;
  signal(): AbortSignal;
}

/** Edu's brains, cloud brains, proposals and crew, built together. */
export function createEduHost(deps: EduHostDeps) {
  const cloud = createEduCloud({ token: deps.token, relay: deps.relay });
  let proposals: EduProposals | null = null;
  const brains = createEduBrains({ dataDir: deps.dataDir, config: deps.config, hostLocal: deps.hostLocal, cloud,
    mounted: (threadId, bot, folder) => proposals?.mounted(threadId, bot, folder) });
  proposals = createEduProposals({ brains, cloud, store: deps.store, bus: deps.bus, desktop: deps.desktop, inRoom: deps.inRoom, decide: deps.decide });
  const crew = createEduCrew({ dataDir: deps.dataDir, brains, store: deps.store, desktop: deps.desktop, decide: deps.decide, ...deps.crew });
  crew.resume();
  void brains.detect();

  return {
    cloud,
    brains,
    proposals,
    crew,

    /** Runs only once the turn's capability is checked: `edu` for the cloud relay, `agents` for the crew tools. */
    async internal(ctx: InternalContext): Promise<typeof PASS | void> {
      if (ctx.path !== EDU_CLOUD_RELAY_PATH) return crew.internal(ctx);
      const bot = deps.store.bot(ctx.botId);
      if (!bot) return ctx.json(ctx.res, 401, { error: "unauthorized" });
      const body = ctx.method === "POST" ? await ctx.readBody() : undefined;
      await sendRelayed(ctx.res, await cloud.relay(bot, { method: ctx.method, headers: ctx.req.headers, body }, ctx.signal()));
    },
  };
}

export type EduHost = ReturnType<typeof createEduHost>;
