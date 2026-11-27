import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { LOCAL_APP_ID, LOCAL_APP_VERSIONS, LOCAL_APPS_MAX, type LocalAppManifest } from "../../shared/local-apps.ts";
import { writeFileAtomic } from "../atomic.ts";
import { appDocRefs } from "../message-db.ts";

const DOC = /^[0-9a-f]{64}$/;

export interface LocalAppVersion {
  rev: number;
  /** The content id of the stored document under app-docs. */
  doc: string;
  at: number;
}

export interface LocalAppRecord {
  id: string;
  name: string;
  icon?: string;
  botId: string;
  threadId: string;
  messageId: string;
  /** Who saved it, as a person key; absent when it was saved on this computer. */
  owner?: string;
  /** A starter app: it came with MausBot, from no bot and no chat. */
  sample?: true;
  versions: LocalAppVersion[];
  pinnedRev?: number;
  createdAt: number;
  updatedAt: number;
  manifest: LocalAppManifest;
}

export const localAppsFile = (dataDir: string) => join(dataDir, "local-apps.json");

function readRecords(file: string): LocalAppRecord[] {
  return readFile(file) ?? [];
}

/** null when the file is there but isn't one this build reads. */
function readFile(file: string): LocalAppRecord[] | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  try {
    const parsed = JSON.parse(text) as { version?: unknown; apps?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.apps)) return null;
    return parsed.apps.filter((app): app is LocalAppRecord => typeof app?.id === "string" && LOCAL_APP_ID.test(app.id) &&
      typeof app.name === "string" && typeof app.botId === "string" && typeof app.threadId === "string" && typeof app.messageId === "string" &&
      Array.isArray(app.versions) && app.versions.length > 0 && app.versions.every((version: LocalAppVersion) => typeof version?.doc === "string" && DOC.test(version.doc) && Number.isInteger(version.rev)));
  } catch {
    return null;
  }
}

/** Every document a saved app keeps, read from its file: the app-docs sweep keeps them however the chat changed. */
export function localAppDocRefs(dataDir: string): string[] {
  return readRecords(localAppsFile(dataDir)).flatMap((app) => app.versions.map((version) => version.doc));
}

/** The chat's documents and the saved apps' together: what the app-docs sweep must keep. */
export const withLocalAppDocs = (dataDir: string) => (): string[] => [...appDocRefs(), ...localAppDocRefs(dataDir)];

/** The newest versions, the pinned one always among them. */
export function keptVersions(versions: readonly LocalAppVersion[], pinnedRev?: number): LocalAppVersion[] {
  const sorted = [...versions].sort((a, b) => a.rev - b.rev);
  const newest = sorted.slice(-LOCAL_APP_VERSIONS);
  const pinned = pinnedRev === undefined ? undefined : sorted.find((version) => version.rev === pinnedRev);
  return pinned && !newest.includes(pinned) ? [pinned, ...newest.slice(1)] : newest;
}

/** The apps saved on this server, in one small JSON file in the data folder. */
export class LocalAppsStore {
  private records: LocalAppRecord[];
  private readonly file: string;
  /** False when the file was there but unreadable: it starts empty, and nothing is added for the person. */
  readonly readable: boolean;

  constructor(dataDir: string) {
    this.file = localAppsFile(dataDir);
    const read = readFile(this.file);
    this.readable = read !== null;
    this.records = read ?? [];
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, apps: this.records }), { mode: 0o600 });
  }

  list(): readonly LocalAppRecord[] {
    return this.records;
  }

  get(id: string): LocalAppRecord | null {
    return this.records.find((record) => record.id === id) ?? null;
  }

  fromPage(threadId: string, messageId: string, owner: string | undefined): LocalAppRecord | null {
    return this.records.find((record) => record.threadId === threadId && record.messageId === messageId && record.owner === owner) ?? null;
  }

  savedFrom(threadId: string, messageId: string): LocalAppRecord[] {
    return this.records.filter((record) => record.threadId === threadId && record.messageId === messageId);
  }

  full(): boolean {
    return this.records.length >= LOCAL_APPS_MAX;
  }

  add(input: Omit<LocalAppRecord, "id" | "createdAt" | "updatedAt">, now = Date.now()): LocalAppRecord {
    const record: LocalAppRecord = { ...input, id: `la_${randomBytes(12).toString("base64url")}`, versions: keptVersions(input.versions), createdAt: now, updatedAt: now };
    this.records = [record, ...this.records];
    this.save();
    return record;
  }

  /** After the apps already here, as many as there is room for. */
  append(records: readonly LocalAppRecord[]): void {
    const room = records.filter((record) => !this.get(record.id)).slice(0, Math.max(0, LOCAL_APPS_MAX - this.records.length));
    if (!room.length) return;
    this.records = [...this.records, ...room.map((record) => ({ ...record, versions: keptVersions(record.versions) }))];
    this.save();
  }

  update(id: string, change: (record: LocalAppRecord) => LocalAppRecord, now = Date.now()): LocalAppRecord | null {
    const index = this.records.findIndex((record) => record.id === id);
    if (index === -1) return null;
    const changed = change(this.records[index]!);
    const versions = keptVersions(changed.versions, changed.pinnedRev);
    const { pinnedRev, ...rest } = changed;
    const pinned = pinnedRev !== undefined && versions.some((version) => version.rev === pinnedRev) ? { pinnedRev } : {};
    const record: LocalAppRecord = { ...rest, ...pinned, versions, updatedAt: now };
    this.records = this.records.map((one, at) => (at === index ? record : one));
    this.save();
    return record;
  }

  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length === before) return false;
    this.save();
    return true;
  }
}
