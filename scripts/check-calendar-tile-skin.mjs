import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routinesSource = await readFile(new URL("../src/components/RoutinesPage.tsx", import.meta.url), "utf8");
const centipedeStyles = await readFile(new URL("../src/components/centipede/centipede-desktop.css", import.meta.url), "utf8");

assert.ok(
  routinesSource.includes("data-centipede-calendar-tile"),
  "Calendar event tiles must expose the Agent Centipede tile contract.",
);

assert.ok(
  routinesSource.includes("centipede-calendar-tile"),
  "Calendar event tiles must use the Agent Centipede tile component class.",
);

for (const requiredStyle of [
  ".centipede-calendar-tile",
  "var(--centipede-line)",
  "var(--centipede-card)",
  "var(--centipede-ink)",
  "var(--centipede-muted)",
]) {
  assert.ok(
    centipedeStyles.includes(requiredStyle),
    `Agent Centipede calendar styles must include ${requiredStyle}.`,
  );
}

process.stdout.write("Agent Centipede calendar tile contract passed.\n");
