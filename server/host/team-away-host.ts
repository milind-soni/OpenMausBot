// The Team Cloud's "when you are away" emails, put together: the client that asks the Admin (team-away.ts) and what of the
// inbox and the notifications is worth one (team-away-events.ts). Off a team every hook does nothing.
import type { Notification } from "../../shared/notification.ts";
import type { Audience } from "../audience.ts";
import type { CloudHomeConfig } from "../cloud-home.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { SessionRecord } from "../sessions.ts";
import type { Store } from "../store.ts";
import type { Delivery, Item } from "./person-inbox.ts";
import { createTeamAway } from "./team-away.ts";
import { createTeamAwayEvents } from "./team-away-events.ts";

export interface TeamAwayHostDeps {
  cloudHome: CloudHomeConfig | null;
  dataDir: string;
  /** Whether this person has the team open now: the one place that decides "away". */
  here(person: string): boolean;
  people(): readonly { email: string; leftAt?: number | string }[];
  language(person: string): string | undefined;
  audienceOf(threadId: string): Audience;
  store: Pick<Store, "bot" | "groupByThread" | "activePath" | "messagesFor">;
  unseen(person: string): readonly { id: string }[];
  session(auth: RequestAuth): SessionRecord | null;
}

export interface TeamAwayHost {
  /** A line reached a person's inbox (person-inbox.ts `delivered`). */
  delivered(item: Item, delivery: Delivery): void;
  /** A notification went out, as `notify` had it and as the inbox routed it. */
  notified(original: Notification | null, routed: Notification | null, how?: { routine?: boolean }): void;
  /** `GET`/`PUT /api/me/away-emails`. */
  routes: RouteHandler;
}

export function createTeamAwayHost(deps: TeamAwayHostDeps): TeamAwayHost {
  const home = deps.cloudHome;
  if (!home?.team) return { delivered: () => {}, notified: () => {}, routes: (async () => PASS) as RouteHandler };
  const windowMs = Number(process.env.OMB_TEAM_AWAY_WINDOW_MS);
  const away = createTeamAway({
    here: deps.here, language: deps.language, dataDir: deps.dataDir, adminOrigin: home.adminOrigin, machineId: home.machineId, secret: home.bootstrapSecret,
    member: (person) => deps.people().find((one) => one.leftAt === undefined && personKey({ id: "", email: one.email }) === person),
    log: (line) => console.log(`team cloud: ${line}`), ...(windowMs > 0 ? { windowMs } : {}),
  });
  const events = createTeamAwayEvents({ audienceOf: deps.audienceOf, store: deps.store, unseen: deps.unseen, noticed: away.noticed });
  return {
    delivered: events.delivered,
    notified: (original, routed, how) => { if (original) events.notified(original, routed, how); },
    routes: away.routes(deps.session),
  };
}
