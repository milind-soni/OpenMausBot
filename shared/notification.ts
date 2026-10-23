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
  /** A bot's settled room reply tagged the person (`@you` or their profile name). Rooms only. */
  | "mention"
  /** The workspace crossed its monthly spend warning or reached its cap.
   * Sent to admins only, at most once per month for each. */
  | "spend"
  /** The main agent's brief has something new that needs the person, or a
   * meeting prep or reminder it posted with no AI turn. Personal installs only. */
  | "brief";

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
}

/** A `Notification` as the feed stores it: the live `notify` frame and `GET /api/notifications` carry the same entry. */
export interface NotificationLogEntry extends Notification {
  id: string;
  at: number;
  read: boolean;
}

/** A bot conversation thread's notification mute, as WireTask carries it. */
export interface WireThreadMute {
  /** Muted: the thread's notifications stay off the person's devices, except
   * the ones `THREAD_MUTE_POLICY` (server/thread-mute.ts) keeps: everything
   * waiting on the person (approvals, questions, sign-ins, a turn that ended
   * needing input), escalations and incidents no Chief of Staff received, a
   * failure unless the Chief took its report, the brief's news for the
   * person, and spend alerts. Its messages
   * and unread state are unchanged. Stored only once a person or a Chief of
   * Staff chose it; always the effective value on the wire. */
  notificationsMuted?: boolean;
  /** Who chose `notificationsMuted`; a Chief of Staff never changes the person's choice. */
  notificationsMutedBy?: "person" | "chief";
  /** true: nobody chose, so `features.muteBotOpenedThreads` decides. Derived
   * at projection, never stored. */
  followsMuteDefault?: boolean;
}
