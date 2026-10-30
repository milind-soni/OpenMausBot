// Facts bots added to About me on their own; a removed fact is remembered by identity and never added again.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { factIdentity, foldForMatch, passageMatcher } from "./memory-entries.ts";
import { redactSecretsInText } from "./redact.ts";

const MAX_KEPT = 200;
const MAX_REMOVED = 500;
const MAX_FORGOTTEN = 200;
const TEXT_MAX = 300;

export interface LearnedFact {
  id: string;
  text: string;
  line: string;
  botId: string;
  botName: string;
  at: number;
}

interface LearnedFile {
  learned: LearnedFact[];
  removed: string[];
  /** What the person asked a bot to forget, as they named it: no bot learns a fact that mentions one again. */
  forgotten?: string[];
}

function filePath(): string {
  return join(DATA_DIR, "profile-learned.json");
}

function load(): LearnedFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath(), "utf8")) as Partial<LearnedFile>;
    const learned = Array.isArray(parsed.learned)
      ? parsed.learned.filter((f): f is LearnedFact =>
        Boolean(f) && typeof f.id === "string" && typeof f.text === "string" && typeof f.line === "string" && typeof f.botId === "string" && typeof f.botName === "string" && typeof f.at === "number")
      : [];
    const removed = Array.isArray(parsed.removed) ? parsed.removed.filter((r): r is string => typeof r === "string") : [];
    const forgotten = Array.isArray(parsed.forgotten) ? parsed.forgotten.filter((r): r is string => typeof r === "string") : [];
    return { learned, removed, forgotten };
  } catch {
    return { learned: [], removed: [], forgotten: [] };
  }
}

function save(file: LearnedFile): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(filePath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

export function listLearnedFacts(): LearnedFact[] {
  return [...load().learned].reverse();
}

export function aboutMeLine(fact: { text: string; botName: string }, today: string): string {
  return `- ${today} · learned by ${fact.botName.replace(/·/g, "-").replace(/\s+/g, " ").trim().slice(0, 60)} · ${fact.text}`;
}

/** A line aboutMeLine wrote: learned from chats, not typed by the person. */
export const LEARNED_LINE = /^\s*-\s*\d{4}-\d{2}-\d{2} · learned by [^·\n]* · /;

function lineIdentity(line: string): string {
  return factIdentity(line.replace(LEARNED_LINE, ""));
}

export function planLearned(from: { botId: string; botName: string }, texts: readonly string[], aboutMe: string, today: string, now = Date.now()): LearnedFact[] {
  const file = load();
  const known = new Set([...file.removed, ...aboutMe.split("\n").map(lineIdentity)]);
  const forgotten = forgottenIn(file);
  const out: LearnedFact[] = [];
  for (const raw of texts) {
    const text = redactSecretsInText(raw.replace(/\s+/g, " ").trim()).slice(0, TEXT_MAX);
    const key = factIdentity(text);
    if (!key || known.has(key) || forgotten(text)) continue;
    known.add(key);
    out.push({ id: randomUUID(), text, line: aboutMeLine({ text, botName: from.botName }, today), botId: from.botId, botName: from.botName, at: now });
  }
  return out;
}

export function commitLearned(facts: readonly LearnedFact[]): void {
  if (!facts.length) return;
  const file = load();
  file.learned = [...file.learned, ...facts].slice(-MAX_KEPT);
  save(file);
}

export function appendAboutMe(aboutMe: string, lines: readonly string[], maxChars = 24_000): string | null {
  if (!lines.length) return aboutMe;
  const base = aboutMe.replace(/\s+$/, "");
  const next = base ? `${base}\n${lines.join("\n")}` : lines.join("\n");
  return next.length > maxChars ? null : next;
}

function forgottenIn(file: LearnedFile): (text: string) => boolean {
  const matchers = (file.forgotten ?? []).map(passageMatcher).filter((match): match is (text: string) => boolean => match !== null);
  return (text) => matchers.some((matches) => matches(text));
}

export function isForgotten(text: string): boolean {
  return forgottenIn(load())(text);
}

/** Learned facts that mention it are dropped and never added again, and so is any fact that mentions it later. */
export function rememberForgotten(passage: string, mentions: (text: string) => boolean): void {
  const file = load();
  const gone = file.learned.filter((fact) => mentions(fact.text));
  const folded = foldForMatch(passage);
  file.learned = file.learned.filter((fact) => !mentions(fact.text));
  file.removed = [...file.removed, ...gone.map((fact) => factIdentity(fact.text))].slice(-MAX_REMOVED);
  file.forgotten = [...(file.forgotten ?? []).filter((kept) => kept !== folded), folded].slice(-MAX_FORGOTTEN);
  save(file);
}

/** The person asked to remember something again: what they forgot before stops blocking it. */
export function clearForgotten(text: string): void {
  const file = load();
  const kept = (file.forgotten ?? []).filter((passage) => !passageMatcher(passage)?.(text));
  if (kept.length === (file.forgotten ?? []).length) return;
  save({ ...file, forgotten: kept, removed: file.removed.filter((identity) => identity !== factIdentity(text)) });
}

/** Save About me before committing removal, so a failed profile save leaves the fact retryable. */
export function removeLearned(id: string, aboutMe: string, saveAboutMe?: (text: string) => void): { fact: LearnedFact; aboutMe: string } | null {
  const file = load();
  const fact = file.learned.find((f) => f.id === id);
  if (!fact) return null;
  const lines = aboutMe.split("\n");
  const at = lines.indexOf(fact.line);
  if (at !== -1) lines.splice(at, 1);
  const next = lines.join("\n");
  if (next !== aboutMe) saveAboutMe?.(next);
  file.learned = file.learned.filter((f) => f.id !== id);
  file.removed = [...file.removed, factIdentity(fact.text)].slice(-MAX_REMOVED);
  save(file);
  return { fact, aboutMe: next };
}

/** What this server learned about the person, and what the person removed, as another server takes them. */
export function learnedState(): { learned: LearnedFact[]; removed: string[] } {
  const { learned, removed } = load();
  return { learned, removed };
}

/** Another server's learned facts and removals: each fact neither removed here nor already in About me is added to it
 * once, and its removals are remembered here too. Null when About me has no room for them. */
export function adoptLearned(facts: readonly LearnedFact[], removed: readonly string[], aboutMe: string): { aboutMe: string; added: number } | null {
  const file = load();
  const tombstones = new Set([...file.removed, ...removed]);
  const known = new Set([...file.learned.map((fact) => factIdentity(fact.text)), ...aboutMe.split("\n").map(lineIdentity)]);
  const held = new Set([...file.learned.map((fact) => fact.id), ...file.learned.map((fact) => factIdentity(fact.text))]);
  const lines: string[] = [], kept: LearnedFact[] = [];
  for (const fact of facts) {
    const key = factIdentity(fact.text);
    if (!key || tombstones.has(key)) continue;
    if (!held.has(fact.id) && !held.has(key)) { kept.push(fact); held.add(fact.id).add(key); }
    if (!known.has(key)) { lines.push(fact.line); known.add(key); }
  }
  const next = appendAboutMe(aboutMe, lines);
  if (next === null) return null;
  const removals = [...new Set([...file.removed, ...removed])].slice(-MAX_REMOVED);
  if (kept.length || removals.length !== file.removed.length) save({ ...file, learned: [...file.learned, ...kept].slice(-MAX_KEPT), removed: removals });
  return { aboutMe: next, added: lines.length };
}
