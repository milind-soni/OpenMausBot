/** The notification wire shape: what the harness decides is worth
 * interrupting someone for, emitted as the `notify` live frame. */
export type NotifyKind =
  | "approval"
  | "question"
  | "done"
  | "routine-failed"
  | "routine-deferred"
  | "turn-failed"
  /** A run failed, stalled or could not start and no Chief of Staff was
   * there to take it: the person is the one who has to look. */
  | "incident"
  /** A bot asked the person to sign in to a website themselves
   * (request_sign_in): it waits on their hands, at the place it works. */
  | "sign-in"
  /** A delegated room request settled and the coordinator auto-resumed with
   * the results; both are internal, so without this the parent conversation
   * sits silent until the resume's first token. */
  | "delegation-settled"
  /** A bot's settled room reply tagged the person (`@you` or their profile name). Rooms only. On a Team Cloud also
   * a teammate tagged by name, or a message a bot passed on to them, with `forPerson`. */
  | "mention"
  /** The workspace crossed its monthly spend warning or reached its cap.
   * Sent to admins only, at most once per month for each. */
  | "spend"
  /** The main agent's brief has something new that needs the person, or a
   * meeting prep or reminder it posted with no AI turn. Personal installs only. */
  | "brief"
  /** A wait a bot set up (wait_until) fired: what it was waiting for happened. */
  | "wait"
  /** Something OpenMausBot changed on its own that the person hears about
   * once: a tool turned off for the bots it doesn't start for. */
  | "notice";

export interface Notification {
  kind: NotifyKind;
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  body: string;
  /** The bot's stored profile image, when it has one; clients show it as
   * the OS notification's icon so every banner carries its bot's face. */
  avatarUrl?: string;
  /** The room this came out of, when the bot was speaking in one. Routing
   * already works off `threadId` alone; this is what lets a client say which
   * room, and stack a room's banners together instead of under the bot. */
  groupId?: string;
  /** On a Team Cloud, the one person this is for (their person key): a teammate tagged by name, or the person a bot
   * passed a message to. It reaches nobody else, an admin included. */
  forPerson?: string;
}

/** A `Notification` as the feed stores it: the live `notify` frame and `GET /api/notifications` carry the same entry. */
export interface NotificationLogEntry extends Notification {
  id: string;
  at: number;
  read: boolean;
}
