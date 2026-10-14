import type { IncomingMessage } from "node:http";
import { join } from "node:path";

import { DEFAULT_COMPANION_CONTROL_PLANE_URL } from "../../electron/companion-account-service.mjs";
import type { Notification } from "../../shared/notification.ts";
import type { Viewer, VisibleSet } from "../bot-visibility.ts";
import type { AppConfig } from "../config.ts";
import { PhonePush, PhonePushAccessSource, phonePushEnabled } from "../phone-push.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createPhonePushRoutes, phonePushIdentity } from "../routes/phone-push.ts";
import type { RouteHandler } from "../routes/table.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { Store } from "../store.ts";

export interface PhonePushHostDeps {
  dataDir: string;
  cfg: () => AppConfig;
  store: () => Pick<Store, "group" | "groupByThread">;
  sessions: Pick<SessionRegistry, "list">;
  visibleTo: (viewer: Viewer) => VisibleSet;
  streams: () => Iterable<{ pushKey?: string }>;
}

export interface PhonePushHost {
  receive(message: unknown): boolean;
  dispatch: PhonePush["dispatch"];
  forget(key: string): void;
  enabled(): boolean;
  streamKey(req: IncomingMessage, auth: RequestAuth): string | null;
  routes(): RouteHandler;
}

export function createPhonePushHost(deps: PhonePushHostDeps): PhonePushHost {
  const access = new PhonePushAccessSource({
    tunnelFile: join(deps.dataDir, "tunnel-account.json"),
    defaultControlPlane: DEFAULT_COMPANION_CONTROL_PLANE_URL,
  });

  /** The rule a phone's event stream applies, for a phone with no stream open. */
  function audience(key: string, notification: Notification, adminOnly: boolean): boolean {
    if (key.startsWith("companion:")) return true;
    const session = deps.sessions.list().find((candidate) => `session:${candidate.id}` === key);
    if (!session) return false;
    if (session.scopes.includes("admin")) return true;
    if (adminOnly) return false;
    const visible = deps.visibleTo({ kind: "member", ...(session.email ? { email: session.email } : {}) });
    return visible.everything || (visible.thread(notification.threadId) && (!notification.botId || visible.bot(notification.botId)));
  }

  const push = new PhonePush({
    file: join(deps.dataDir, "push-devices.json"),
    access: () => access.current(),
    enabled: () => phonePushEnabled(deps.cfg()),
    live: (key) => Array.from(deps.streams()).some((client) => client.pushKey === key),
    audience,
    room: (notification) => {
      const store = deps.store();
      const group = (notification.groupId ? store.group(notification.groupId) : undefined) ?? store.groupByThread(notification.threadId);
      return group && !group.dm ? { id: group.id, name: group.name } : undefined;
    },
  });

  return {
    receive: (message) => access.receive(message),
    dispatch: (notification, options) => push.dispatch(notification, options),
    forget: (key) => push.forget(key),
    enabled: () => phonePushEnabled(deps.cfg()),
    streamKey: phonePushIdentity,
    routes: () => createPhonePushRoutes({ push }),
  };
}
