// One persistent store for every channel that reaches a person outside the app: phone
// calls, SMS, and the voice worker's call context. The app's routes, the public Twilio
// door and the LiveKit voice worker all read and write this same file, so a call's
// context survives into the chat and a chat's facts reach the phone.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { redactSecretsInText } from "../redact.ts";

export const TELEPHONY_STORE_VERSION = 1;
export const TELEPHONY_STORE_FILE = "store.json";
export const SMS_MAX_BODY_CHARS = 1600;
export const FACT_MAX_CHARS = 2000;
export const MAX_SMS_RECORDS = 500;
export const MAX_CALL_RECORDS = 200;
export const MAX_FACTS = 500;

export type SmsDirection = "in" | "out";
export type SmsStatus = "received" | "sent" | "failed" | "ignored";
export type CallDirection = "in" | "out";
export type CallStatus = "ringing" | "answered" | "done" | "missed" | "failed" | "voicemail";
export type FactSource = "phone" | "sms" | "voice";

export interface SmsRecord {
  id: string;
  direction: SmsDirection;
  from: string;
  to: string;
  body: string;
  at: number;
  status: SmsStatus;
  /** An inbound SMS this outbound reply answers. */
  replyTo?: string;
  /** A screened draft waiting for approval; present only while status is "received". */
  proposedReply?: string;
}

export interface CallTurn {
  who: "caller" | "bot";
  text: string;
  at: number;
}

export interface CallRecord {
  id: string;
  direction: CallDirection;
  from: string;
  to: string;
  at: number;
  status: CallStatus;
  objective?: string;
  durationSec?: number;
  recordingUrl?: string;
  turns?: CallTurn[];
}

export interface MemoryFact {
  id: string;
  text: string;
  source: FactSource;
  at: number;
}

export interface TelephonyFile {
  version: number;
  sms: SmsRecord[];
  calls: CallRecord[];
  facts: MemoryFact[];
}

export interface TelephonyStore {
  file: string;
  appendSms(record: Omit<SmsRecord, "id"> & { id?: string }): SmsRecord;
  patchSms(id: string, patch: Partial<Omit<SmsRecord, "id">>): SmsRecord | undefined;
  listSms(limit?: number): SmsRecord[];
  appendCall(record: Omit<CallRecord, "id"> & { id?: string }): CallRecord;
  patchCall(id: string, patch: Partial<Omit<CallRecord, "id">>): CallRecord | undefined;
  listCalls(limit?: number): CallRecord[];
  appendCallTurn(callId: string, turn: CallTurn): void;
  appendFact(text: string, source: FactSource): MemoryFact | undefined;
  facts(limit?: number): MemoryFact[];
  /** The context a fresh call or turn starts from: facts first, then the recent tail. */
  recentContext(limit?: number): string[];
  snapshot(): TelephonyFile;
}

export function telephonyStoreFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMB_TELEPHONY_STORE?.trim();
  return override ? override : join(DATA_DIR, "telephony", TELEPHONY_STORE_FILE);
}

export function newId(prefix: string, now = Date.now()): string {
  return `${prefix}_${now}_${Math.random().toString(36).slice(2, 10)}`;
}

const clean = (text: string) => redactSecretsInText(text ?? "").slice(0, SMS_MAX_BODY_CHARS * 4);

function emptyFile(): TelephonyFile {
  return { version: TELEPHONY_STORE_VERSION, sms: [], calls: [], facts: [] };
}

function load(file: string): TelephonyFile {
  if (!existsSync(file)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TelephonyFile>;
    if (parsed.version !== TELEPHONY_STORE_VERSION) return emptyFile();
    return {
      version: TELEPHONY_STORE_VERSION,
      sms: Array.isArray(parsed.sms) ? parsed.sms : [],
      calls: Array.isArray(parsed.calls) ? parsed.calls : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
    };
  } catch {
    return emptyFile();
  }
}

/** A JSON-backed store; every write is atomic and redacts secrets out of free text. */
export function openTelephonyStore(file: string): TelephonyStore {
  let data = load(file);

  const persist = () => {
    data.sms = data.sms.slice(-MAX_SMS_RECORDS);
    data.calls = data.calls.slice(-MAX_CALL_RECORDS);
    data.facts = data.facts.slice(-MAX_FACTS);
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  };

  return {
    file,
    appendSms(record) {
      const row: SmsRecord = {
        ...record,
        id: record.id ?? newId("sms"),
        body: clean(record.body),
        at: record.at,
      };
      data.sms.push(row);
      persist();
      return row;
    },
    patchSms(id, patch) {
      const row = data.sms.find((r) => r.id === id);
      if (!row) return undefined;
      Object.assign(row, patch, { id: row.id });
      if (typeof patch.body === "string") row.body = clean(patch.body);
      persist();
      return row;
    },
    listSms(limit = MAX_SMS_RECORDS) {
      return data.sms.slice(-limit).reverse();
    },
    appendCall(record) {
      const row: CallRecord = {
        ...record,
        id: record.id ?? newId("call"),
        objective: record.objective ? clean(record.objective) : undefined,
        turns: record.turns?.map((turn) => ({ ...turn, text: clean(turn.text) })),
      };
      data.calls.push(row);
      persist();
      return row;
    },
    patchCall(id, patch) {
      const row = data.calls.find((r) => r.id === id);
      if (!row) return undefined;
      Object.assign(row, patch, { id: row.id });
      if (typeof patch.objective === "string") row.objective = clean(patch.objective);
      persist();
      return row;
    },
    listCalls(limit = MAX_CALL_RECORDS) {
      return data.calls.slice(-limit).reverse();
    },
    appendCallTurn(callId, turn) {
      const row = data.calls.find((r) => r.id === callId);
      if (!row) return;
      row.turns = [...(row.turns ?? []), { ...turn, text: clean(turn.text) }].slice(-200);
      persist();
    },
    appendFact(text, source) {
      const trimmed = clean(text).trim().slice(0, FACT_MAX_CHARS);
      if (!trimmed) return undefined;
      const fact: MemoryFact = { id: newId("fact"), text: trimmed, source, at: Date.now() };
      data.facts.push(fact);
      persist();
      return fact;
    },
    facts(limit = MAX_FACTS) {
      return data.facts.slice(-limit).reverse();
    },
    recentContext(limit = 30) {
      const factLines = data.facts.slice(-limit).map((fact) => fact.text);
      const callLines = data.calls
        .slice(-Math.ceil(limit / 3))
        .flatMap((call) =>
          (call.turns ?? []).map((turn) => `${turn.who === "caller" ? "caller" : "assistant"}: ${turn.text}`),
        )
        .slice(-limit);
      const smsLines = data.sms.slice(-Math.ceil(limit / 2)).map((sms) => `${sms.direction === "in" ? sms.from : "me"}: ${sms.body}`);
      return [...factLines, ...callLines, ...smsLines].slice(-limit);
    },
    snapshot() {
      return JSON.parse(JSON.stringify(data)) as TelephonyFile;
    },
  };
}