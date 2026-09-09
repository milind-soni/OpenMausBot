/** Profile input limits shared by every web and server write surface.
 * name, title, description, and voice are character counts. soul is a
 * UTF-8 byte budget: it rides the system prompt on every turn, and what
 * that costs is bytes, not glyphs. */
export const BOT_PROFILE_LIMITS = {
  name: 100,
  title: 200,
  description: 4000,
  voice: 200,
  soul: 24_000,
} as const;
