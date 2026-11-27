// Writes the widget fixtures the phone apps' core tests read. Every tree comes
// from parseWidgetInput over WIDGET_SAMPLES, so the phones decode exactly what
// this server stores.
//
//   node --experimental-strip-types scripts/gen-widget-fixtures.ts <fixtures dir>
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { WIDGET_SAMPLES } from "../shared/widget-samples.ts";
import {
  parseWidgetInput, widgetActions, widgetFields, widgetInitialValues, widgetScope, widgetTakesOther, widgetToText, type WidgetPayload, type WidgetRoot,
} from "../shared/widget.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: gen-widget-fixtures.ts <fixtures dir>");

const AT = 1791930000000;
const messages: unknown[] = [];
const expectations: Record<string, unknown> = {};

function widgetMessage(id: string, payload: WidgetPayload, at: number) {
  return { id, at, role: "bot", kind: "widget", text: widgetToText(payload.root), widget: payload };
}

function parsed(name: string, input: unknown): WidgetRoot {
  const result = parseWidgetInput(input);
  if (!result.ok) throw new Error(`${name}: ${result.error}`);
  return result.value;
}

function expectationsFor(root: WidgetRoot) {
  const actions = widgetActions(root);
  return {
    pressable: actions.filter((entry) => !entry.client).map((entry) => entry.ref),
    onDevice: actions.filter((entry) => entry.client).map((entry) => entry.ref),
    settles: actions.filter((entry) => entry.tone).map((entry) => entry.ref),
    scopes: Object.fromEntries(actions.filter((entry) => !entry.client).map((entry) => {
      const scope = widgetScope(root, entry.ref);
      return [entry.ref, { fields: widgetFields(scope, root).map((field) => field.name), initial: widgetInitialValues(scope) }];
    })),
    takesOther: widgetFields(root).filter((field) => widgetTakesOther(field.node)).map((field) => field.name),
  };
}

Object.entries(WIDGET_SAMPLES).forEach(([name, input], index) => {
  const root = parsed(name, input);
  const id = `widget-${name}`;
  messages.push(widgetMessage(id, { v: 1, root }, AT + index * 1000));
  expectations[id] = expectationsFor(root);
});

// The bot turned Other off on one of two choices.
const closed = parsed("closed", { type: "Card", title: "Shirt", confirm: { label: "Order", action: { type: "order" } }, children: [
  { type: "RadioGroup", name: "size", label: "Size", options: ["S", "M", "L"], allowOther: false },
  { type: "Select", name: "colour", label: "Colour", options: ["Green", "Black"] },
] });
messages.push(widgetMessage("widget-closed", { v: 1, root: closed }, AT + 15_000));
expectations["widget-closed"] = expectationsFor(closed);

const list = parseWidgetInput(WIDGET_SAMPLES.pullRequests);
if (!list.ok) throw new Error(list.error);
messages.push(widgetMessage("widget-settled", { v: 1, root: list.value, settled: { ref: "confirm", label: "Merge the two ready", tone: "confirm", at: AT + 60_000, sendId: "send-1" } }, AT + 20_000));
messages.push({ id: "widget-answer", at: AT + 60_000, role: "user", kind: "text", text: "Merge the two ready", replyToId: "widget-settled" });
// Answered with Other: the choice's own value is empty and the words travel apart.
messages.push(widgetMessage("widget-settled-other", { v: 1, root: parsed("dinnerChoice", WIDGET_SAMPLES.dinnerChoice), settled: {
  ref: "confirm", label: "Pick this", tone: "confirm", at: AT + 65_000, sendId: "send-2", values: { dish: "" }, other: { dish: "Leftover dal" },
} }, AT + 62_000));
// What a newer server might send: a node type and props this build has never
// seen, and a node without an id. A client draws what it knows.
messages.push({
  id: "widget-future", at: AT + 70_000, role: "bot", kind: "widget", text: "**From the future**\nStill readable",
  widget: { v: 1, sparkle: true, root: { type: "Card", id: "n1", title: "From the future", glow: 3, children: [
    { type: "Carousel", id: "n2", autoplay: true, children: [{ type: "Text", id: "n3", value: "Still readable" }] },
    { type: "Hologram", id: "n4" },
    { type: "Text", value: "No id on this one" },
  ] } },
});
// Not a tree at all: the row falls back to its text.
messages.push({ id: "widget-broken", at: AT + 80_000, role: "bot", kind: "widget", text: "A widget this build cannot read", widget: { v: 1, root: "nope" } });

writeFileSync(join(dir, "widget-messages.json"), `${JSON.stringify({ messages, hasMore: false }, null, 2)}\n`);
writeFileSync(join(dir, "widget-expectations.json"), `${JSON.stringify(expectations, null, 2)}\n`);
console.log(`wrote ${messages.length} messages and ${Object.keys(expectations).length} expectations to ${dir}`);
