import { describe, expect, it } from "vitest";
import { heldTail } from "../../server/host/snapshot-tail.ts";
import { lastLine } from "@/components/sidebar-preview";
import { endedOnFailure, stateForBot } from "@/lib/mascot";
import { lastNonReceipt } from "@/lib/receipts";
import { unreadDividerFor } from "@/lib/unread-divider";
import { SNAPSHOT_TAIL } from "./chat-snapshot";
import { MESSAGE_PAGE_SIZE } from "./message-history";
import { visibleMessages } from "./snapshot-navigation";
import type { Bot, Message } from "./store";

type Row = Message & { parentId: string | null };
type Page = { messages: Row[]; hasMore: boolean; activeLeafId: string | null };

/** A conversation of `count` rows from a seeded mix of the person, other bots, replies, tool steps, screens and
 * receipts, with an edit now and then that starts a branch. */
function conversation(seed: number, count: number, kinds: { person: number; tool: number }): { rows: Row[]; leaf: string | null } {
  let state = seed;
  const random = () => ((state = (state * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  const rows: Row[] = [];
  let leaf: string | null = null;
  for (let index = 0; index < count; index++) {
    const id = `s${seed}-${index}`;
    const roll = random();
    const edit = rows.length > 4 && random() < 0.02;
    const parentId = edit ? rows[rows.length - 3]!.parentId : leaf;
    const base = { id, at: index, parentId };
    const row: Row = roll < kinds.person ? { ...base, role: "user", kind: "text", text: `ask ${index}` }
      : roll < kinds.person + 0.03 ? { ...base, role: "user", kind: "text", text: `[From @Scout (bot) · message · reply expected] help ${index}` }
      : roll < kinds.person + 0.03 + kinds.tool ? { ...base, role: "bot", kind: "activity", tool: { name: "Bash", ok: random() > 0.1, input: "{}" } }
      : roll < kinds.person + 0.08 + kinds.tool ? { ...base, role: "bot", kind: random() < 0.5 ? "screen" : "digest" }
      : { ...base, role: "bot", kind: "text", text: `reply ${index}` };
    rows.push(row as Row);
    leaf = id;
  }
  if (seed % 7 === 0 && rows.length > 40) leaf = rows[rows.length - 30]!.id;
  return { rows, leaf };
}

const pageOf = ({ rows, leaf }: { rows: Row[]; leaf: string | null }) => (limit: number): Page =>
  ({ messages: rows.slice(-limit), hasMore: rows.length > limit, activeLeafId: leaf });

/** Everything a client reads from a conversation it holds but does not show. */
function reads(page: Page, cursor: string | undefined) {
  const bot = { id: "b", name: "Scout", threadId: "t", messages: page.messages, activeLeafId: page.activeLeafId, hasMore: page.hasMore } as unknown as Bot;
  const shown = visibleMessages(bot);
  return {
    simplePreview: lastLine(bot, shown, [], false),
    advancedPreview: lastLine(bot, shown, [], true),
    divider: unreadDividerFor("t", shown, cursor, page.hasMore)?.messageId ?? null,
    mascot: lastNonReceipt(page.messages)?.id,
    sidebarMascot: stateForBot({ ...bot, messages: shown }),
    sidebarFailed: endedOnFailure(shown),
    lastPersonRole: page.messages.findLast((message) => message.role === "user")?.id,
    lastTool: page.messages.findLast((message) => message.kind === "activity" && message.tool)?.id,
  };
}

describe("a snapshot's tail of a conversation nobody has open", () => {
  const mixes = [{ person: 0.1, tool: 0.5 }, { person: 0.01, tool: 0.7 }, { person: 0, tool: 0.3 }, { person: 0.3, tool: 0 }, { person: 0.02, tool: 0 }];

  it("reads the same preview, divider, mascot, team-map step and last person line as a whole page", () => {
    let tailed = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const mix = mixes[seed % mixes.length]!;
      const thread = conversation(seed, 30 + ((seed * 37) % 400), mix);
      const read = pageOf(thread);
      const cursors = [undefined, thread.rows[Math.floor(thread.rows.length * 0.4)]!.id, thread.rows.at(-5)!.id];
      for (const cursor of cursors) {
        const tail = heldTail(read, SNAPSHOT_TAIL, MESSAGE_PAGE_SIZE, cursor);
        const page = read(MESSAGE_PAGE_SIZE);
        expect(page.messages.slice(-tail.messages.length)).toEqual(tail.messages);
        expect(tail.messages.length).toBeGreaterThanOrEqual(Math.min(SNAPSHOT_TAIL, thread.rows.length));
        expect(reads(tail, cursor), `seed ${seed}, cursor ${cursor}`).toEqual(reads(page, cursor));
        if (tail.messages.length < page.messages.length) {
          tailed++;
          expect(tail.hasMore).toBe(true);
        }
      }
    }
    expect(tailed).toBeGreaterThan(100);
  });

  it("stops at the floor when the person spoke last, and reaches back past other bots' lines to the person's", () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({ id: `m${index}`, at: index, parentId: index ? `m${index - 1}` : null, role: "bot", kind: "activity", tool: { name: "Bash", ok: true, input: "{}" } })) as Row[];
    rows[299] = { ...rows[299]!, role: "user", kind: "text", text: "next?", tool: undefined };
    expect(heldTail(pageOf({ rows, leaf: "m299" }), 20, 200).messages).toHaveLength(20);

    rows[299] = { ...rows[299]!, text: "[From @Scout (bot) · message · reply expected] hi" };
    rows[250] = { ...rows[250]!, role: "user", kind: "text", text: "do it", tool: undefined };
    rows[270] = { ...rows[270]!, role: "bot", kind: "text", text: "done", tool: undefined };
    const tail = heldTail(pageOf({ rows, leaf: "m299" }), 20, 200);
    expect(tail.messages[0]!.id).toBe("m250");
    expect(tail.hasMore).toBe(true);
  });

  it("reaches back at most one page, and sends a conversation shorter than the floor whole", () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({ id: `m${index}`, at: index, parentId: index ? `m${index - 1}` : null, role: "bot", kind: "activity", tool: { name: "Bash", ok: true, input: "{}" } })) as Row[];
    const withPerson = (at: number) => rows.map((row, index) => index === at ? { ...row, role: "user", kind: "text", text: "go", tool: undefined } as Row : row);
    expect(heldTail(pageOf({ rows: withPerson(320), leaf: "m499" }), 20, 200).messages[0]!.id).toBe("m320");
    expect(heldTail(pageOf({ rows: withPerson(150), leaf: "m499" }), 20, 200).messages).toHaveLength(20);
    const short = rows.slice(0, 12);
    expect(heldTail(pageOf({ rows: short, leaf: "m11" }), 20, 200)).toEqual({ messages: short, hasMore: false, activeLeafId: "m11" });
  });
});
