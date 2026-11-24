// Which conversations' messages mention any of some words, read off the event loop: one read-only query of messages.db
// in a short-lived worker, so a large transcript store never stalls a turn. Used before a deleted conversation's
// folders are cleaned, to keep what a remaining conversation still names.
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  db = new DatabaseSync(workerData.file, { readOnly: true });
  const words = workerData.words;
  const where = words.map(() => "instr(json, ?) > 0").join(" OR ");
  const rows = db.prepare("SELECT thread_id, json FROM messages WHERE " + where).all(...words);
  const found = {};
  for (const row of rows) for (const word of words) if (row.json.includes(word)) (found[word] ??= new Set()).add(row.thread_id);
  parentPort.postMessage({ found: Object.fromEntries(Object.entries(found).map(([word, ids]) => [word, [...ids]])) });
} catch (error) {
  parentPort.postMessage({ error: String(error && error.message || error) });
} finally {
  try { db && db.close(); } catch {}
}
`;

const MAX_WORDS = 200;
const TIMEOUT_MS = 120_000;

/** For each word, the conversations whose stored messages hold it. Rejects when the transcripts cannot be read, so a
 * caller that keeps on failure keeps. */
export async function threadsMentioning(file: string, words: readonly string[]): Promise<Map<string, Set<string>>> {
  const unique = [...new Set(words.filter(Boolean))];
  const result = new Map<string, Set<string>>();
  if (!unique.length) return result;
  if (!existsSync(file)) throw new Error("the transcripts are missing");
  for (let at = 0; at < unique.length; at += MAX_WORDS) {
    const chunk = unique.slice(at, at + MAX_WORDS);
    const found = await new Promise<Record<string, string[]>>((resolve, reject) => {
      const worker = new Worker(WORKER, { eval: true, workerData: { file, words: chunk }, execArgv: [] });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error("reading the transcripts took too long")); }, TIMEOUT_MS);
      worker.once("message", (reply: { found?: Record<string, string[]>; error?: string }) => {
        clearTimeout(timer);
        void worker.terminate();
        if (reply.error !== undefined || !reply.found) reject(new Error(reply.error ?? "no answer"));
        else resolve(reply.found);
      });
      worker.once("error", (error) => { clearTimeout(timer); reject(error); });
      worker.once("exit", (exitCode) => { clearTimeout(timer); if (exitCode !== 0) reject(new Error(`stopped (${exitCode})`)); });
    });
    for (const word of chunk) result.set(word, new Set(found[word] ?? []));
  }
  return result;
}
