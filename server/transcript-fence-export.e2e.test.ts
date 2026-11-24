import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fromMarkdown } from "mdast-util-from-markdown";
import { expect, it } from "vitest";

import { runControlOmb } from "../scripts/control-omb.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

it("keeps a persisted unfinished reply separate from its follow-up in HTTP and CLI Markdown exports", async () => {
  const fixture = await launchRestartableServer();
  const { url, dataDir } = fixture;
  const partial = "Here is the example:\n\n```js\nconst answer = 42;";
  const followUp = "Please use Python instead.";
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Coder", "--url", url]) as { bot: { activeTaskId: string } };
    await fixture.stop();
    const db = new DatabaseSync(join(dataDir, "messages.db"));
    try {
      let parentId = db.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(bot.activeTaskId)?.active_leaf_id ?? null;
      for (const [index, text] of [partial, followUp].entries()) {
        const message = { id: `unfinished-reply-${index}`, at: Date.now() + index, role: index ? "user" : "bot", kind: "text", text, parentId };
        db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(bot.activeTaskId, message.id, message.at, message.role, message.kind, message.text, JSON.stringify(message));
        parentId = message.id;
      }
      db.prepare("INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id")
        .run(bot.activeTaskId, parentId);
    } finally {
      db.close();
    }
    await fixture.start();
    expect(await runControlOmb(["doctor", "--url", url])).toMatchObject({ ok: true });

    const response = await fetch(`${url}/api/threads/${bot.activeTaskId}/export`);
    expect(response.status).toBe(200);
    const markdown = await response.text();
    const out = join(dataDir, "exported-conversation");
    const exported = await runControlOmb(["export", "--thread", bot.activeTaskId, "--out", out, "--url", url]) as { transcripts: Array<{ file: string }> };
    const file = exported.transcripts[0]!.file;
    const saved = JSON.parse(readFileSync(join(out, file), "utf8")) as { messages: Array<{ text: string }> };
    expect(saved.messages.slice(-2).map((message) => message.text)).toEqual([partial, followUp]);
    for (const content of [markdown, readFileSync(join(out, file.replace(/\.json$/, ".md")), "utf8")]) {
      const nodes = fromMarkdown(content).children;
      expect(nodes.filter((node) => node.type === "code").map((node) => node.value)).toEqual(["const answer = 42;"]);
      expect(nodes.some((node) => node.type === "paragraph" && node.children.some((child) => child.type === "text" && child.value === followUp))).toBe(true);
    }
  } finally {
    await fixture.close();
  }
}, 90_000);
