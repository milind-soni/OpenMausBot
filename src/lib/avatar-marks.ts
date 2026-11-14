export type AvatarKind = "bot" | "person";
export type AvatarDrawn = "picture" | "mascot" | "initials";

/** Stable attributes on every bot's or person's face, whatever it draws, so a theme can restyle faces. */
export function avatarMarks(kind: AvatarKind | undefined, drawn: AvatarDrawn): { "data-avatar"?: AvatarDrawn; "data-avatar-kind"?: AvatarKind } {
  return kind ? { "data-avatar": drawn, "data-avatar-kind": kind } : {};
}
