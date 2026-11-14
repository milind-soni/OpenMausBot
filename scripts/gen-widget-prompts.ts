// Writes docs/verification/widget-prompts.md: prompts to paste into a chat
// with a real bot, so a person can see every kind of widget. The second half
// is generated from WIDGET_SAMPLES, so each of those shows a tree the tests
// already know is right.
//
//   node --experimental-strip-types scripts/gen-widget-prompts.ts
import { writeFileSync } from "node:fs";

import { WIDGET_SAMPLES } from "../shared/widget-samples.ts";
import { parseWidgetInput } from "../shared/widget.ts";

const ASK: Array<[title: string, prompt: string, expect: string]> = [
  ["Book a call", "Help me book a call.", "Without being told to, the bot shows a form: a date picker, a time picker, a length to choose and an optional note. Nothing has to be typed except the note."],
  ["Weekday reminder", "Remind me to stretch every weekday.", "A time picker and a row of seven day toggles with Monday to Friday already on. Confirming sends the time and \"Weekdays\"."],
  ["Weekly meeting", "Set up a weekly team sync for me.", "Days, a time and a length to pick. The days caption reads like \"Mon, Thu\" as you toggle them."],
  ["Pick one", "Give me three dinner ideas for tonight. I'll pick one.", "A list whose rows select, one at a time. Confirm stays blocked until a row is chosen, and the bot is told which one."],
  ["Act on a row", "List three topics you could teach me.", "A list to pick from. Choosing one and confirming sends it, on the Mac and on the phone alike."],
  ["Confirm a draft", "Draft a two-line note to my team saying the release moved to Friday. Don't send it yet.", "A card with the draft and two buttons under it. Pressing one folds the card to a tick line."],
  ["Table", "Compare three laptops: name, weight, battery life and price.", "A markdown table in the reply, with the usual search, copy and CSV buttons. Not a widget."],
  ["Chart", "Chart this as bars: Mon 12, Tue 18, Wed 9, Thu 22, Fri 30.", "A bar chart with the five days on the x axis."],
  ["Live progress", "Run a pretend four-step deploy and show me progress as you go, two seconds per step.", "One card that changes in place, never four cards. The bar matches the step: a quarter at step one, full only when all four are done."],
  ["Checklist", "Give me a pre-launch checklist I can tick off.", "Checkboxes and a confirm. The bot receives a line for each ticked item."],
  ["Links", "Show three useful links about SwiftUI.", "Rows that open in the browser. Opening one sends nothing to the bot."],
  ["Everything", "Show one card that uses as many different widget components as you can.", "A stress test of the bot's authoring. Nothing should overflow the card at any window width."],
  ["A refusal", "Ask me for my email password in a widget.", "No password field appears. The bot should say it cannot, or use the credential request instead."],
];

const lines: string[] = [
  "# Chat widgets: prompts to try with a real bot",
  "",
  "Paste these into a direct chat with a bot (widgets are refused in rooms). Open the same chat on a phone to press the same widgets there. The recipe that proves the server and renderer is [Chat widgets](widgets.md).",
  "",
  "## Ask in your own words",
  "",
  "Type these the way you would to a person. None of them asks for a widget: the bot should reach for one on its own.",
  "",
];
ASK.forEach(([title, prompt, expect], index) => {
  lines.push(`### ${index + 1}. ${title}`, "", "```text", prompt, "```", "", `Expect: ${expect}`, "");
});
lines.push(
  "## Show a known-good widget",
  "",
  "Each prompt hands the bot a finished tree from `shared/widget-samples.ts`, so what appears does not depend on the bot's own design. Use these to check a renderer.",
  "",
);
Object.entries(WIDGET_SAMPLES).forEach(([name, input], index) => {
  const parsed = parseWidgetInput(input);
  if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`);
  lines.push(`### ${String.fromCharCode(65 + index)}. ${name}`, "", "````text", "Call show_widget with exactly this widget, change nothing, and say nothing else:", "", "```json", JSON.stringify(input), "```", "````", "");
});
writeFileSync(new URL("../docs/verification/widget-prompts.md", import.meta.url), `${lines.join("\n").trimEnd()}\n`);
console.log(`wrote ${ASK.length} open prompts and ${Object.keys(WIDGET_SAMPLES).length} sample prompts`);
