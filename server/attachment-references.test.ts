import { describe, expect, it } from "vitest";

import { createAttachmentReferences, type MessageRow, type MessageRows } from "./attachment-references.ts";
import { messageWritten, watchMessageWrites } from "./message-writes.ts";

const rowsOf = (texts: readonly string[]) => (): MessageRows => (after, limit) =>
  texts.map((json, index): MessageRow => ({ rowid: index + 1, json })).filter((row) => row.rowid > after).slice(0, limit);

/** What the old per-name check answered: the name anywhere in any remaining row (SQLite instr). */
const oldRule = (texts: readonly string[], name: string) => texts.some((text) => text.includes(name));

async function unreferenced(texts: readonly string[], names: readonly string[], over: Parameters<typeof createAttachmentReferences>[0] = {}) {
  const going: string[] = [];
  const references = createAttachmentReferences({ rows: rowsOf(texts), ...over });
  await references.removeUnreferenced(names, (batch) => { going.push(...batch); return batch.length; });
  return going.sort();
}

describe("which uploads no remaining message names", () => {
  it("agrees with the old per-name check on names inside longer words, prefixes, suffixes and odd characters", async () => {
    const names = ["a.png", "ba.png", "a.png.bak", "x", "photo-1.jpg", "photo-12.jpg", "été.pdf", "😀.gif", "q\"uote.txt", "none.png", "9f86d081-0000.png"];
    const texts = [
      JSON.stringify({ text: "see /api/attachments/ba.png and copy-photo-12.jpg.old" }),
      JSON.stringify({ path: "C:\\data\\attachments\\été.pdf" }),
      JSON.stringify({ text: "😀.gif" }),
      JSON.stringify({ text: "q\"uote.txt" }),
      JSON.stringify({ text: "nothing here", id: "9f86d081-0000.pn" }),
    ];
    const expected = names.filter((name) => !oldRule(texts, name)).sort();
    expect(await unreferenced(texts, names)).toEqual(expected);
    expect(expected).toEqual(["9f86d081-0000.png", "a.png.bak", "none.png", "photo-1.jpg", "q\"uote.txt"].sort());
  });

  it("agrees with the old per-name check on a random corpus", async () => {
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const alphabet = "ab.-_1";
    const word = (max: number) => Array.from({ length: 1 + Math.floor(random() * max) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    const names = [...new Set(Array.from({ length: 300 }, () => word(6)))];
    const texts = Array.from({ length: 400 }, () => JSON.stringify({ text: Array.from({ length: 6 }, () => word(9)).join(" / ") }));
    const expected = names.filter((name) => !oldRule(texts, name)).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(names.length);
    expect(await unreferenced(texts, names)).toEqual(expected);
  });

  it("splits a long list of names into several matchers and still reads each row once", async () => {
    const names = Array.from({ length: 3_000 }, (_, i) => `${String(i).padStart(4, "0")}-${"f".repeat(60)}.png`);
    const texts = names.filter((_, i) => i % 3 === 0).map((name) => JSON.stringify({ text: `/api/attachments/${name}` }));
    let read = 0;
    const rows = rowsOf(texts);
    const going = await unreferenced(texts, names, { rows: () => { const inner = rows(); return (after, limit) => { const slice = inner(after, limit); read += slice.length; return slice; }; } });
    expect(going).toEqual(names.filter((_, i) => i % 3 !== 0).sort());
    expect(read).toBe(texts.length);
  });

  it("keeps a name a message written during the pass names", async () => {
    const texts = Array.from({ length: 50 }, (_, i) => JSON.stringify({ text: `row ${i}` }));
    let pauses = 0;
    const going = await unreferenced(texts, ["late.png", "gone.png"], {
      rowsPerRead: 5,
      sliceMs: 0,
      pause: async () => { if (++pauses === 3) messageWritten(JSON.stringify({ text: "/api/attachments/late.png" })); },
    });
    expect(going).toEqual(["gone.png"]);
  });

  it("keeps a name a message written between removal batches names", async () => {
    let pauses = 0;
    const references = createAttachmentReferences({ rows: rowsOf([]), batch: 1, sliceMs: 0, pause: async () => { pauses++; } });
    const going: string[] = [];
    await references.removeUnreferenced(["a.png", "b.png"], (batch) => {
      going.push(...batch);
      messageWritten(JSON.stringify({ text: "b.png" }));
      return batch.length;
    });
    expect(going).toEqual(["a.png"]);
    expect(pauses).toBeGreaterThan(1);
  });

  it("removes nothing when the pass cannot finish", async () => {
    const references = createAttachmentReferences({ rows: () => () => { throw new Error("messages.db was reopened during the check"); } });
    const going: string[] = [];
    await expect(references.removeUnreferenced(["a.png"], (batch) => { going.push(...batch); return batch.length; })).rejects.toThrow("reopened");
    expect(going).toEqual([]);
  });

  it("runs one pass at a time, and names asked for meanwhile share the next pass", async () => {
    const texts = Array.from({ length: 200 }, (_, i) => JSON.stringify({ text: i === 150 ? "c.png" : `row ${i}` }));
    let reading = 0, overlapped = false, passesStarted = 0;
    const rows = rowsOf(texts);
    const references = createAttachmentReferences({
      rowsPerRead: 10,
      sliceMs: 0,
      rows: () => { passesStarted++; const inner = rows(); return (after, limit) => { reading++; if (reading > 1) overlapped = true; const slice = inner(after, limit); reading--; return slice; }; },
    });
    const going: string[] = [];
    // As a real remover: a file another request's batch already took is not there to take again.
    const remove = (batch: readonly string[]) => { const fresh = batch.filter((name) => !going.includes(name)); going.push(...fresh); return fresh.length; };
    const first = references.removeUnreferenced(["a.png"], remove);
    await new Promise((done) => setImmediate(done));
    await new Promise((done) => setImmediate(done));
    expect(references.passes).toBe(1);
    const second = references.removeUnreferenced(["b.png", "c.png"], remove);
    const third = references.removeUnreferenced(["b.png", "d.png"], remove);
    expect(await Promise.all([first, second, third])).toEqual([1, 1, 1]);
    expect([references.passes, passesStarted, overlapped]).toEqual([2, 2, false]);
    expect(going).toEqual(["a.png", "b.png", "d.png"]);
  });

  it("stops watching writes once its pass and removals are done", async () => {
    let watching = 0;
    const references = createAttachmentReferences({ rows: rowsOf([]), watchWrites: (listener) => { watching++; const stop = watchMessageWrites(listener); return () => { watching--; stop(); }; } });
    await references.removeUnreferenced(["a.png"], (batch) => batch.length);
    expect(watching).toBe(0);
  });
});
