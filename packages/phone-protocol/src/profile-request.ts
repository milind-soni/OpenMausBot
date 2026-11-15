/**
 * Durable payload carried by a profile confirmation card (propose_profile).
 *
 * The fields a bot may propose for itself (`cwd` is the working folder its
 * tools run in; "" means its private workspace; `notifications` and
 * `speakReplies` are the alert and voice toggles). `before` is the snapshot
 * the user was shown; `expectedRevision` is a hash of the target's whole
 * profile at proposal time so a confirmation fails closed if anything moved.
 */
export const PROFILE_REQUEST_FIELDS = ["name", "title", "description", "soul", "cwd", "notifications", "speakReplies"] as const;
export type ProfileRequestField = (typeof PROFILE_REQUEST_FIELDS)[number];
export type ProfileRequestChanges = Partial<Record<Exclude<ProfileRequestField, "notifications" | "speakReplies">, string>> &
  Partial<Record<"notifications" | "speakReplies", boolean>> & {
    /** A Chief's change of another bot's browser profile: a profile id, "guest"
     * (temporary browser) or "" (the bot's own browser). Kept out of
     * PROFILE_REQUEST_FIELDS, so profile versions and rollback never write it. */
    browserProfile?: string;
  };

export interface ProfileRequestCardData {
  version: 1;
  requestId: string;
  /** The proposing conversation; authority is fixed here. */
  botId: string;
  threadId: string;
  /** Whose profile changes: the proposer, or a section peer named by a Chief. */
  targetBotId: string;
  targetName: string;
  createdAt: number;
  reason: string;
  changes: ProfileRequestChanges;
  before: ProfileRequestChanges;
  expectedRevision: string;
  appliedAt?: number;
  /** Written when the change applied without a person: the profile's
   * revision right after it, so Undo refuses once anything moved. Absent
   * when the before values could not be kept exactly (credential-shaped
   * text is scrubbed from cards), which means no Undo. */
  undo?: { appliedRevision: string };
}
