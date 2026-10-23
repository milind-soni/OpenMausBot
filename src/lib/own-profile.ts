import { api, type ConfigStatus } from "@/state/store";

export type OwnProfile = NonNullable<ConfigStatus["profile"]>;

/** Settings → Profile on a Team Cloud: the signed-in person's own profile (PUT /api/me, open to every member). The
 * address is their sign-in's and never changes here. Elsewhere Settings → Profile is the server's one profile. */
export function saveTeamProfile(patch: Partial<Pick<OwnProfile, "name" | "aboutMe" | "avatarUrl">>): Promise<OwnProfile> {
  return api<OwnProfile>("/api/me", { method: "PUT", body: JSON.stringify(patch), timeoutMs: 10_000 });
}

/** On a Team Cloud, whose words a person's line is when they are not the viewer's: their name over the line. Null on the
 * viewer's own lines, and wherever one person uses the server (`viewer` null). */
export function otherSpeaker(message: { role: string; sender?: { name: string; id?: string } }, viewer: string | null): string | null {
  if (!viewer || message.role !== "user" || !message.sender?.id || message.sender.id === viewer) return null;
  return message.sender.name.trim() || null;
}
