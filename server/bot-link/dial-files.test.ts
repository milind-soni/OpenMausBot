import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { PassedFile } from "../host/handoff-files.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createDialer } from "./dial.ts";
import type { BotLink, FileTransfer } from "./link.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function transferUsing(fetch: typeof globalThis.fetch) {
  let transfer!: FileTransfer;
  const link = {
    dial: () => ({ origin: "https://fixture.invalid", token: "fixture-token" }),
    setTransfer: (next: FileTransfer | null) => { if (next) transfer = next; },
    onOutgoing: () => () => {}, onWanted: () => () => {},
  } as unknown as BotLink;
  const dialer = createDialer({ link, fetch });
  cleanups.push(() => dialer.close());
  return transfer;
}

function file() {
  const dir = mkdtempSync(join(tmpdir(), "bot-link-missing-file-"));
  cleanups.push(() => removeTempDir(dir));
  const path = join(dir, "report.txt"), content = "Completed report";
  writeFileSync(path, content);
  const file: PassedFile = { path, name: "report.txt", mime: "text/plain", kind: "file", bytes: Buffer.byteLength(content) };
  return { dir, file, content };
}

it.each(["missing", "non-directory"] as const)("marks a %s upload source as unavailable before making a request", async (kind) => {
  const fixture = file();
  const missing: PassedFile = { ...fixture.file, path: kind === "missing" ? join(fixture.dir, "deleted.txt") : join(fixture.file.path, "child.txt") };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const transfer = transferUsing(fetch);
  await expect(transfer.push("work", "returned", 0, missing)).rejects.toMatchObject({ gone: true });
  expect(fetch).not.toHaveBeenCalled();
});

it("uploads the original bytes and cancels the successful response body", async () => {
  const fixture = file();
  let sent: RequestInit | undefined;
  const cancel = vi.fn();
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    sent = init;
    return new Response(new ReadableStream({ cancel }), { status: 200 });
  };
  await transferUsing(fetch).push("work", "returned", 0, fixture.file);
  expect(sent?.method).toBe("PUT");
  expect(await (sent!.body as Blob).text()).toBe(fixture.content);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("keeps a temporary HTTP refusal retryable", async () => {
  const fixture = file();
  const fetch: typeof globalThis.fetch = async () => Response.json({ error: "try again" }, { status: 503 });
  await expect(transferUsing(fetch).push("work", "returned", 0, fixture.file)).rejects.toMatchObject({ gone: false, message: "try again" });
});

it("does not classify an error from the transport as a missing local source", async () => {
  const fixture = file();
  const error = Object.assign(new Error("transport interrupted"), { code: "ENOENT" });
  const fetch: typeof globalThis.fetch = async () => { throw error; };
  await expect(transferUsing(fetch).push("work", "sent", 0, fixture.file)).rejects.toBe(error);
  expect(error).not.toHaveProperty("gone");
});
