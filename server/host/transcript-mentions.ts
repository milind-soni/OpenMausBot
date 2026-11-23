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
  if (workerData.threads) {
    parentPort.postMessage({ threads: db.prepare("SELECT DISTINCT thread_id FROM messages").all().map((row) => row.thread_id) });
  } else {
    const words = workerData.words;
    const where = words.map(() => "instr(json, ?) > 0").join(" OR ");
    const rows = db.prepare("SELECT thread_id, json FROM messages WHERE " + where).all(...words);
    const found = {};
    for (const row of rows) for (const word of words) if (row.json.includes(word)) (found[word] ??= new Set()).add(row.thread_id);
    parentPort.postMessage({ found: Object.fromEntries(Object.entries(found).map(([word, ids]) => [word, [...ids]])) });
  }
} catch (error) {
  parentPort.postMessage({ error: String(error && error.message || error) });
} finally {
  try { db && db.close(); } catch {}
}
`;

const MAX_WORDS = 200;
const TIMEOUT_MS = 120_000;

/** Runs the worker once; rejects on any failure. */
function ask<T>(workerData: Record<string, unknown>, pick: (reply: Record<string, unknown>) => T | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData, execArgv: [] });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("reading the transcripts took too long")); }, TIMEOUT_MS);
    worker.once("message", (reply: Record<string, unknown>) => {
      clearTimeout(timer);
      void worker.terminate();
      const value = reply.error === undefined ? pick(reply) : undefined;
      if (value === undefined) reject(new Error(typeof reply.error === "string" ? reply.error : "no answer"));
      else resolve(value);
    });
    worker.once("error", (error) => { clearTimeout(timer); reject(error); });
    worker.once("exit", (exitCode) => { clearTimeout(timer); if (exitCode !== 0) reject(new Error(`stopped (${exitCode})`)); });
  });
}

/** Every conversation the transcripts hold a message of; rejects when they cannot be read. */
export async function transcriptThreads(file: string): Promise<Set<string>> {
  if (!existsSync(file)) throw new Error("the transcripts are missing");
  return new Set(await ask({ file, threads: true }, (reply) => (Array.isArray(reply.threads) ? reply.threads as string[] : undefined)));
}

/** For each word, the conversations whose stored messages hold it. Rejects when the transcripts cannot be read, so a
 * caller that keeps on failure keeps. */
export async function threadsMentioning(file: string, words: readonly string[]): Promise<Map<string, Set<string>>> {
  const unique = [...new Set(words.filter(Boolean))];
  const result = new Map<string, Set<string>>();
  if (!unique.length) return result;
  if (!existsSync(file)) throw new Error("the transcripts are missing");
  for (let at = 0; at < unique.length; at += MAX_WORDS) {
    const chunk = unique.slice(at, at + MAX_WORDS);
    const found = await ask({ file, words: chunk }, (reply) => (reply.found && typeof reply.found === "object" ? reply.found as Record<string, string[]> : undefined));
    for (const word of chunk) result.set(word, new Set(found[word] ?? []));
  }
  return result;
}
