#!/usr/bin/env node
// Measures the palette in src/styles.css against WCAG 2.1 AA.
//
//   node scripts/check-contrast.mjs        (or: pnpm check:contrast)
//
// It parses the stylesheet instead of keeping a second copy of the values, so
// the check can never pass against a palette that is no longer the shipped
// one. Two things it does that a quick eyeball does not:
//
//   - composites alpha. --color-ink-secondary is #fcfcfc99, and measuring it
//     as opaque #fcfcfc overstates every secondary-text pair in the app.
//   - measures white on filled surfaces, which is what the components
//     actually render (`bg-accent … text-white`), not the token against the
//     page ground.
//
// The three pairs already below AA are listed in KNOWN below with the ratio
// they measure today, so adopting this check does not force a palette change
// in the same commit. Anything new fails the run — and so does a known pair
// that gets WORSE than its recorded floor.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/styles.css"), "utf8");

/** Custom properties from @theme and :root, in cascade order.
 *
 * Comments are stripped first: a declaration left behind in a comment reads
 * exactly like a live one, so a token that was removed but still mentioned
 * would be measured at its stale value instead of reported as undefined. */
function parseTokens(source) {
  const tokens = {};
  const live = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, body] of live.matchAll(/(?:@theme|:root)[^{]*\{([^}]*)\}/g)) {
    for (const [, name, value] of body.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens[name] = value.trim();
    }
  }
  return tokens;
}

/** #rgb, #rrggbb and #rrggbbaa → {r,g,b,a} with channels in 0..1. */
function parseColor(value) {
  const h = value.replace("#", "").trim();
  const full = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) return null;
  const n = (i) => parseInt(full.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) : 1 };
}

/** Lay a possibly-translucent colour over an opaque one. */
function composite(fg, bg) {
  if (fg.a === 1) return fg;
  const mix = (f, b) => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

function luminance({ r, g, b }) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fgValue, bgValue) {
  const bg = parseColor(bgValue);
  const fg = parseColor(fgValue);
  if (!fg || !bg) return null;
  if (bg.a !== 1) return null; // a translucent ground has no single answer
  const [hi, lo] = [luminance(composite(fg, bg)), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = [
  "--color-app",
  "--color-panel",
  "--color-raised",
  "--color-card",
  "--color-inset",
];

// AA asks 4.5:1 of body text and 3:1 of non-text indicators (1.4.11).
const PAIRS = [
  // body and secondary text on every ground a panel can sit on
  ...SURFACES.map((s) => ["--color-ink", s, 4.5, "body text"]),
  ...SURFACES.map((s) => ["--color-ink-secondary", s, 4.5, "secondary text (60% alpha)"]),
  ["--color-ink", "--color-bubble-user", 4.5, "your own messages"],
  // what the filled buttons actually render: white on a solid accent/danger
  ["#ffffff", "--color-accent", 4.5, "primary buttons — bg-accent + text-white"],
  ["#ffffff", "--color-danger", 4.5, "destructive buttons — bg-danger + text-white"],
  // coloured text on a ground
  ["--color-accent", "--color-app", 4.5, "accent as text/links"],
  ["--color-accent", "--color-card", 4.5, "accent as text on a card"],
  ["--color-danger", "--color-card", 4.5, "error text"],
  ["--color-success", "--color-card", 4.5, "success text"],
  ["--color-warning", "--color-card", 4.5, "warning text"],
  // indicators: outline, not glyphs
  ["--color-focus", "--color-app", 3, "focus ring"],
  ["--color-focus", "--color-panel", 3, "focus ring on a panel"],
  ["--color-accent-border", "--color-card", 3, "accent border"],
];

// Below AA on the current palette. Listed so this check can be adopted
// without changing a colour in the same commit — and so that fixing one is a
// visible deletion here rather than a silent pass. Where each one shows up:
//
//   white on accent  3.65:1  every primary button, 12–13px — Composer send,
//                            EngineSetup install, ComputerPanel start, the
//                            Onboarding and Routines actions (28 sites)
//   white on danger  3.10:1  CallView.tsx:532 / GroupCallView.tsx:492, the
//                            hang-up buttons, 14px
//   accent on card   4.15:1  accent links inside a Card — ApiKeys.tsx:121
//                            (12px), EnginesSettings.tsx:241 (11.5px)
//
// Note the shape of the problem before changing anything: --color-accent
// reads fine as text on the page ground (5.33:1 on --color-app) and only
// falls short on the lighter card, while white falls short ON the accent.
// Darkening the one token fixes the buttons and hurts the links, so the fix
// is a separate fill colour, not a nudge — a design call, which is why this
// check only measures.
// Each entry records the ratio the pair measures TODAY, not just its name.
// A floor, not a licence: a carried pair that gets worse is a regression and
// fails like anything else. Improve one past AA and the run says so, so the
// line gets deleted rather than quietly protecting a pair that no longer
// needs it.
const KNOWN = new Map([
  ["#ffffff on --color-accent", 3.65],
  ["#ffffff on --color-danger", 3.1],
  ["--color-accent on --color-card", 4.15],
]);

// Rounding headroom: the floors above are quoted to two decimals, so a value
// that is unchanged can measure a hair under its own printed figure.
const DRIFT = 0.01;

const tokens = parseTokens(css);
const resolve = (name) => (name.startsWith("--") ? tokens[name] : name);

let failed = false;
const carried = [];
let measured = 0;

for (const [fg, bg, min, where] of PAIRS) {
  const fgValue = resolve(fg);
  const bgValue = resolve(bg);
  if (!fgValue || !bgValue) {
    // An unmeasurable pair is reported, never skipped: silently passing over
    // a renamed token is how a check quietly stops checking.
    console.log(`✗ undefined token in pair: ${fg} on ${bg}`);
    failed = true;
    continue;
  }
  const ratio = contrast(fgValue, bgValue);
  if (ratio === null) {
    console.log(`✗ cannot measure ${fg} on ${bg} (${fgValue} on ${bgValue})`);
    failed = true;
    continue;
  }
  measured++;
  if (ratio >= min) continue;

  const key = `${fg} on ${bg}`;
  const line = `${key}: ${ratio.toFixed(2)}:1 (needs ${min}:1) — ${where}`;
  const floor = KNOWN.get(key);
  if (floor === undefined) {
    console.log(`✗ ${line}`);
    failed = true;
  } else if (ratio < floor - DRIFT) {
    console.log(`✗ ${line} — WORSE than the recorded ${floor.toFixed(2)}:1`);
    failed = true;
  } else {
    carried.push(line);
  }
}

// A known pair that now clears AA never reaches the block above, so say it
// here — otherwise the entry sits in KNOWN forever, shielding a pair that no
// longer needs shielding.
for (const [key, floor] of KNOWN) {
  const [fg, bg] = key.split(" on ");
  const fgValue = resolve(fg);
  const bgValue = resolve(bg);
  if (!fgValue || !bgValue) continue;
  const ratio = contrast(fgValue, bgValue);
  if (ratio !== null && ratio >= 4.5) {
    console.log(`✓ ${key} now measures ${ratio.toFixed(2)}:1 — remove it from KNOWN (floor was ${floor.toFixed(2)})`);
  }
}

if (carried.length) {
  console.log("Known, carried (listed in KNOWN):");
  for (const line of carried) console.log(`  ~ ${line}`);
}
console.log(
  failed
    ? `\n${measured} pairs measured — new contrast failures above.`
    : `\n✓ ${measured} pairs measured, no new failures.`,
);
process.exit(failed ? 1 : 0);
