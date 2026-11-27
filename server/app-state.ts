// What bot pages keep for themselves (mausbot.state), under DATA_DIR/app-state/<threadId>/<messageId>.json. A page's
// versions are one row, so they share one file; the file goes with the row.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { APP_LIMITS, utf8Bytes } from "../shared/app.ts";

const ID = /^[\w-]{1,128}$/;

interface StateFile {
  v: 1;
  values: Record<string, unknown>;
}

export type AppStateResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 413; error: string };

export class AppStates {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(threadId: string, messageId: string): string | null {
    return ID.test(threadId) && ID.test(messageId) ? join(this.dir, threadId, `${messageId}.json`) : null;
  }

  private read(file: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as StateFile;
      return parsed && parsed.v === 1 && parsed.values && typeof parsed.values === "object" && !Array.isArray(parsed.values) ? parsed.values : {};
    } catch {
      return {};
    }
  }

  get(threadId: string, messageId: string, key: string): AppStateResult<unknown> {
    const file = this.file(threadId, messageId);
    if (!file) return { ok: false, status: 404, error: "That page is not in this conversation." };
    const values = this.read(file);
    return { ok: true, value: Object.hasOwn(values, key) ? values[key] : undefined };
  }

  keys(threadId: string, messageId: string): AppStateResult<string[]> {
    const file = this.file(threadId, messageId);
    if (!file) return { ok: false, status: 404, error: "That page is not in this conversation." };
    return { ok: true, value: Object.keys(this.read(file)) };
  }

  /** `value` undefined removes the key. */
  set(threadId: string, messageId: string, key: string, value: unknown): AppStateResult<null> {
    const file = this.file(threadId, messageId);
    if (!file) return { ok: false, status: 404, error: "That page is not in this conversation." };
    if (!key || key.length > APP_LIMITS.pageStateKeyChars) return { ok: false, status: 400, error: `A state key is text of 1 to ${APP_LIMITS.pageStateKeyChars} characters.` };
    const values = this.read(file);
    if (value === undefined) {
      if (!Object.hasOwn(values, key)) return { ok: true, value: null };
      delete values[key];
    } else {
      let text: string | undefined;
      try { text = JSON.stringify(value); } catch { text = undefined; }
      if (text === undefined) return { ok: false, status: 400, error: "A state value is anything JSON can hold." };
      if (utf8Bytes(text) > APP_LIMITS.pageStateValueBytes) {
        return { ok: false, status: 413, error: `A state value is at most ${APP_LIMITS.pageStateValueBytes} bytes as JSON.` };
      }
      if (!Object.hasOwn(values, key) && Object.keys(values).length >= APP_LIMITS.pageStateKeys) {
        return { ok: false, status: 413, error: `A page keeps at most ${APP_LIMITS.pageStateKeys} keys; remove one first.` };
      }
      values[key] = JSON.parse(text) as unknown;
    }
    const body = JSON.stringify({ v: 1, values } satisfies StateFile);
    if (utf8Bytes(body) > APP_LIMITS.pageStateBytes) {
      return { ok: false, status: 413, error: `A page keeps at most ${APP_LIMITS.pageStateBytes} bytes of state; remove something first.` };
    }
    if (Object.keys(values).length === 0) {
      try { unlinkSync(file); } catch { /* never written */ }
      return { ok: true, value: null };
    }
    mkdirSync(join(this.dir, threadId), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, body, { mode: 0o600 });
    renameSync(temp, file);
    return { ok: true, value: null };
  }

  /** Removes the state of every page whose row is gone; how many files went. */
  sweep(rowExists: (threadId: string, messageId: string) => boolean): number {
    let removed = 0;
    let threads: string[];
    try { threads = readdirSync(this.dir); } catch { return 0; }
    for (const threadId of threads) {
      const folder = join(this.dir, threadId);
      let names: string[];
      try { names = readdirSync(folder); } catch { continue; }
      let left = names.length;
      for (const name of names) {
        const messageId = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
        if (!name.endsWith(".tmp") && ID.test(threadId) && ID.test(messageId) && rowExists(threadId, messageId)) continue;
        try { unlinkSync(join(folder, name)); removed += 1; left -= 1; } catch { /* gone meanwhile */ }
      }
      if (left === 0) { try { rmdirSync(folder); } catch { /* written meanwhile */ } }
    }
    return removed;
  }
}
