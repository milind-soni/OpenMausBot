import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MAUS_COLORS, MAUS_COLOR_NAMES } from "@/lib/mascot";
import { MentionText } from "./MentionText";
import { ChatMarkdown } from "./ChatMarkdown";

it.each(["plain text", "Markdown"] as const)("keeps all ten bot colors independent in %s", (renderer) => {
  const peers = MAUS_COLOR_NAMES.map((color) => ({ name: `Bot ${color}`, color }));
  const ordered = [...peers, ...[...peers].reverse(), peers[0]];
  const text = ordered.map(({ name }) => `@${name} ordinary @everyone @Unknown`).join("\n\n");
  for (const roster of [peers, [...peers].reverse()]) {
    const html = renderToStaticMarkup(renderer === "plain text"
      ? createElement(MentionText, { text, peers: roster, everyone: true })
      : createElement(ChatMarkdown, { text, mentionPeers: roster, everyone: true }));
    const colors = [...html.matchAll(/style="--mention-color:([^"]+)" class="bot-mention"/g)].map(([, color]) => color);
    expect(colors).toEqual(ordered.map(({ color }) => MAUS_COLORS[color]));
    expect(html.match(/data-bot-mention=""/g)).toHaveLength(ordered.length);
    expect(html.match(/<\/span> ordinary /g)).toHaveLength(ordered.length);
    expect(html.match(/<\/span> @Unknown/g)).toHaveLength(ordered.length);
  }
});
