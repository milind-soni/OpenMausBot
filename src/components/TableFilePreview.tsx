import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Table2 } from "lucide-react";
import { requestMessageFile, type MessageAttachmentContext } from "./AttachmentPreview";
import { OutsideWorkspacePreview, refusedAsOutsideWorkspace } from "./OutsideWorkspacePreview";
import { RichTable, TableDialog } from "./RichTable";
import { useFileBesideChat } from "@/lib/file-preview";
import { TABLE_FILE_MAX_BYTES, tableDelimiter, type TextTable } from "@/lib/table-data";
import { t } from "@/lib/i18n";

/** A preview limit, not a download limit: chunked responses are bounded too. Text that is not UTF-8 is refused, unless
 * `fallback` names a single-byte encoding to read it in instead; a NUL byte (UTF-16, binary) is refused even
 * then, since such an encoding would only show it as garbage. */
export async function readTableResponse(response: Response, signal: AbortSignal, maxBytes = TABLE_FILE_MAX_BYTES, fallback?: string): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => {}); throw new Error("size"); // A body that already errored must not hide "size".
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error("size");
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
  // NUL is valid UTF-8, so UTF-16 without a byte order mark would pass the UTF-8 check: look for it first.
  if (fallback && bytes.includes(0)) throw new Error("encoding");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (error) {
    if (!fallback) throw error;
    return new TextDecoder(fallback).decode(bytes);
  }
}

export function TableFileButton({ path, shownPath, name, message }: { path: string; shownPath?: string; name: string; message: MessageAttachmentContext }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const beside = useFileBesideChat();
  const delimiter = tableDelimiter(name) ?? tableDelimiter(path);
  if (!delimiter) return null;
  const show = () => {
    if (!beside({ kind: "table", path, shownPath, name, message, opener: trigger.current })) setOpen(true);
  };
  return <>
    <button ref={trigger} type="button" className="table-action" title={t("table.preview", { name })} aria-label={t("table.preview", { name })} onClick={show}><Table2 size={14} /></button>
    {open && <TableDialog title={name} returnFocus={trigger.current} onClose={() => setOpen(false)}><TableFileContent key={`${message.threadId}:${message.messageId}:${path}`} path={path} shownPath={shownPath} name={name} message={message} delimiter={delimiter} /></TableDialog>}
  </>;
}

export function TableFileContent({ path, shownPath = path, name, message, delimiter }: {
  path: string; shownPath?: string; name: string; message: MessageAttachmentContext; delimiter: "," | "\t";
}) {
  const [attempt, setAttempt] = useState(0);
  const [table, setTable] = useState<TextTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let worker: Worker | undefined;
    setError(null);
    setTable(null);
    const fail = (reason: string) => {
      if (!controller.signal.aborted) setError(reason);
      worker?.terminate();
    };
    void (async () => {
      try {
        const response = await requestMessageFile(path, message, controller.signal);
        const text = await readTableResponse(response, controller.signal);
        controller.signal.throwIfAborted();
        worker = new Worker(new URL("../lib/table-file.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<{ table?: TextTable; error?: string }>) => {
          if (event.data.error) fail(event.data.error);
          else if (!controller.signal.aborted && event.data.table) setTable(event.data.table);
          worker?.terminate();
        };
        worker.onerror = () => fail("format");
        worker.postMessage({ text, delimiter });
      } catch (reason) { fail(refusedAsOutsideWorkspace(reason) ? "outside" : reason instanceof Error && reason.message === "size" ? "size" : "load"); }
    })();
    return () => { controller.abort(); worker?.terminate(); };
  }, [path, message.threadId, message.messageId, delimiter, attempt]);
  const data = useMemo(() => table && ({ columns: table.headers.map((text) => ({ text })), rows: table.rows.map((row) => row.map((text) => ({ text }))) }), [table]);
  if (error === "outside") return <OutsideWorkspacePreview filePath={shownPath} />;
  if (error) return <div className="p-8 text-center text-sm"><p role="alert" className="mb-3 text-ink-secondary">{t(error === "size" ? "table.tooLarge" : error === "columns" || error === "format" ? "table.invalid" : "table.loadFailed")}</p><button type="button" className="rounded-lg border border-hairline px-3 py-2 hover:bg-raised" onClick={() => setAttempt(attempt + 1)}>{t("chat.retry")}</button></div>;
  if (!data) return <div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t("table.loading")}</div>;
  return <RichTable {...data} name={name} expanded />;
}
