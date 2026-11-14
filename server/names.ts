const NAMES = [
  "Scout", "Pixel", "Atlas", "Nova", "Juno", "Koda", "Miso", "Mochi",
  "Biscuit", "Pepper", "Clover", "Ember", "Willow", "Comet", "Orbit", "Echo",
  "Indigo", "Sage", "Zephyr", "Poppy", "Maple", "Cosmo", "Luna", "Otto",
  "Ivy", "Finch", "Wren", "Basil", "Hazel", "Nimbus", "Onyx", "Pearl",
  "Quill", "Rocket", "Sunny", "Tango", "Vega", "Waffle", "Ziggy", "Noodle",
  "Pickle", "Churro", "Panko", "Dumpling", "Pesto", "Olive", "Cocoa", "Taffy",
  "Bramble", "Fig", "Juniper", "Moss", "Pebble", "Rio", "Skye", "Tuli",
  "Ursa", "Yuki", "Zuko", "Momo", "Kiwi", "Plum", "Sprout", "Turnip",
];

export function pickBotName(taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const free = NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  const base = NAMES[Math.floor(Math.random() * NAMES.length)];
  for (let i = 2; ; i++) {
    if (!used.has(`${base.toLowerCase()} ${i}`)) return `${base} ${i}`;
  }
}

const PICKED = new Set(NAMES.map((name) => name.toLowerCase()));

/** A name pickBotName could have given ("Pesto", "Pesto 2"): New bot sends one from /api/bot-defaults' suggestedName. */
export function isPickedBotName(name: string): boolean {
  return PICKED.has(name.trim().toLowerCase().replace(/ \d+$/, ""));
}
