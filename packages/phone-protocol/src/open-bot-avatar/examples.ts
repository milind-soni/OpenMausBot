import type { AvatarDefinition } from './types.ts';

/**
 * Starter avatars, produced with the generate-avatar design prompt. The
 * face-bearing part is always the dominant mass, so the enlarged runtime eyes
 * keep visible room (see faceRoom in volume.ts), and accessories stay small by
 * their outer extent, hollow loops included. Outlines wind clockwise;
 * holes (handles, loops) wind counter-clockwise so the nonzero fill rule cuts
 * them. Tests keep these equal to the skill's example run and the examples in
 * skills/generate-avatar/references/system-prompt.md.
 */
export const examples: AvatarDefinition[] = [
  // Front view: one squat body; the face sits on the wide center above the grips.
  {
    version: 1,
    id: 'controller',
    name: 'Controller',
    body: {
      path:
        'M28 22C38 20 44 23 50 23C56 23 62 20 72 22C84 24 90 34 91 48C92 62 91 76 82 80C75 83 69 78 66 72C63 67 58 66 50 66C42 66 37 67 34 72C31 78 25 83 18 80C9 76 8 62 9 48C10 34 16 24 28 22Z',
    },
    eyes: { x: 50, y: 42, spacing: 16, scale: 1.05 },
  },
  // Side view, mirror-symmetric about y 50 so it turns as a bar with round plates: two weight tiers a side and a soft bar end.
  {
    version: 1,
    id: 'barbell',
    name: 'Barbell',
    body: {
      path:
        'M12 41H12A4 4 0 0 1 16 45V55A4 4 0 0 1 12 59H12A4 4 0 0 1 8 55V45A4 4 0 0 1 12 41Z' +
        'M18 29H18A4 4 0 0 1 22 33V67A4 4 0 0 1 18 71H18A4 4 0 0 1 14 67V33A4 4 0 0 1 18 29Z' +
        'M26 17H26A5 5 0 0 1 31 22V78A5 5 0 0 1 26 83H26A5 5 0 0 1 21 78V22A5 5 0 0 1 26 17Z' +
        'M38 33H62A10 10 0 0 1 72 43V57A10 10 0 0 1 62 67H38A10 10 0 0 1 28 57V43A10 10 0 0 1 38 33Z' +
        'M74 17H74A5 5 0 0 1 79 22V78A5 5 0 0 1 74 83H74A5 5 0 0 1 69 78V22A5 5 0 0 1 74 17Z' +
        'M82 29H82A4 4 0 0 1 86 33V67A4 4 0 0 1 82 71H82A4 4 0 0 1 78 67V33A4 4 0 0 1 82 29Z' +
        'M88 41H88A4 4 0 0 1 92 45V55A4 4 0 0 1 88 59H88A4 4 0 0 1 84 55V45A4 4 0 0 1 88 41Z',
    },
    eyes: { x: 50, y: 50, spacing: 15, scale: 1.05 },
  },
  // Side view: the cup carries the face and dominates; a compact handle loop stays a see-through cut-out.
  {
    version: 1,
    id: 'mug',
    name: 'Mug',
    body: {
      path:
        'M22 20H62C67 20 70 23 70 28V72C70 80 64 86 56 86H28C20 86 14 80 14 72V28C14 23 17 20 22 20Z' +
        'M68 36C80 34 87 42 87 53C87 64 80 72 68 70Z' +
        'M69 45L69 61C75.5 62 79 58.5 79 53C79 47.5 76 44 69 45Z',
    },
    eyes: { x: 42, y: 49, spacing: 16, scale: 1.15 },
  },
  // Front view: a big round globe for the face; its neck runs flush into a straight base (one smooth outline), then a clear step down to the contact cap.
  {
    version: 1,
    id: 'lightbulb',
    name: 'Lightbulb',
    body: {
      path:
        'M36 72V66C36 60 18 55 18 40A32 32 0 0 1 82 40C82 55 64 60 64 66V72Z' +
        'M36 68H64V77A4 4 0 0 1 60 81H40A4 4 0 0 1 36 77Z' +
        'M43 78H57V84A4 4 0 0 1 53 88H47A4 4 0 0 1 43 84Z',
    },
    eyes: { x: 50, y: 40, spacing: 17, scale: 1.2 },
  },
  // A wide speech bubble with a small tail.
  {
    version: 1,
    id: 'chat',
    name: 'Chat',
    body: {
      path:
        'M28 14H72C82 14 90 22 90 32V54C90 64 82 72 72 72H42L25 86C23.5 87.3 21.5 86 22.3 84L27 71.5C17 70 10 63 10 54V32C10 22 18 14 28 14Z',
    },
    eyes: { x: 50, y: 42, spacing: 18, scale: 1.25 },
  },
  // Side view: a big pot (rim + tapered body) hosts the face; a stem with a small bud and two curving leaf blades that taper to soft tips.
  {
    version: 1,
    id: 'sprout',
    name: 'Sprout',
    body: {
      path:
        'M49.5 19H50.5A3 3 0 0 1 53.5 22V46H46.5V22A3 3 0 0 1 49.5 19Z' +
        'M49 38C36 41 22.5 36 17.6 23.4A1.4 1.4 0 0 1 18.4 21.6C29 17.5 41.5 21.5 49 34Z' +
        'M51 30C57 14.5 72 8.5 82.6 11.8A1.4 1.4 0 0 1 83.5 13.4C80.5 27.5 66 35.5 51 34Z' +
        'M24 44H76A4 4 0 0 1 80 48V54A4 4 0 0 1 76 58H24A4 4 0 0 1 20 54V48A4 4 0 0 1 24 44Z' +
        'M24 56H76L71 84C70.4 87.5 68 90 64.5 90H35.5C32 90 29.6 87.5 29 84Z',
    },
    eyes: { x: 50, y: 71, spacing: 16, scale: 1.05 },
  },
  // Side view: a big can body hosts the face; a small rear handle loop, joined to the body at both ends, and a short spout name it.
  {
    version: 1,
    id: 'watering-can',
    name: 'Watering Can',
    body: {
      path:
        'M32 38H62C68 38 71 41 72 47L74 76C74.5 82 70 86 64 86H30C24 86 19.5 82 20 76L22 47C23 41 26 38 32 38Z' +
        'M23 63C14 63 8.5 57 8.5 48C8.5 37 13 30.5 19 30.5C25 30.5 28.5 34 30 39.5L26 52Z' +
        'M23.5 42C22 38 20 36 17.5 36C15 36 14 41 14 48C14 54 16 57.5 22 58L23.5 47Z' +
        'M69 66C75 61 78 55 80 46.5L88 49.5C85 62 80 73 72 81Z' +
        'M78.7 43A7 4.5 25 0 1 91.3 49A7 4.5 25 0 1 78.7 43Z',
    },
    eyes: { x: 47, y: 61, spacing: 16, scale: 1.15 },
  },
];

export function getExample(id: string): AvatarDefinition | undefined {
  return examples.find((e) => e.id === id);
}
