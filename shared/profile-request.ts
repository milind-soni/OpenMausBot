/**
 * Durable payload carried by a profile confirmation card (propose_profile).
 *
 * The fields a bot may propose for itself (`cwd` is the working folder its
 * tools run in; "" means its private workspace). `before` is the snapshot the
 * user was shown; `expectedRevision` is a hash of the target's whole profile
 * at proposal time so a confirmation fails closed if anything moved.
 */
export const PROFILE_REQUEST_FIELDS = ["name", "title", "description", "soul", "cwd"] as const;
export type ProfileRequestField = (typeof PROFILE_REQUEST_FIELDS)[number];
export type ProfileRequestChanges = Partial<Record<ProfileRequestField, string>>;

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
}
