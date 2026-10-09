import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Table2 } from "lucide-react";
import { requestMessageFile, type MessageAttachmentContext } from "./AttachmentPreview";
import { RichTable, TableDialog } from "./RichTable";
import { TABLE_FILE_MAX_BYTES, tableDelimiter, type TextTable } from "@/lib/table-data";
import { t } from "@/lib/i18n";

/** Bound chunked responses too; this is a preview limit, not a download limit. */
export async function readTableResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > TABLE_FILE_MAX_BYTES) {
    await response.body?.cancel(); throw new Error("size");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > TABLE_FILE_MAX_BYTES) throw new Error("size");
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function TableFileButton({ path, name, message }: { path: string; name: string; message: MessageAttachmentContext }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const delimiter = tableDelimiter(name) ?? tableDelimiter(path);
  if (!delimiter) return null;
  return <>
    <button ref={trigger} type="button" className="table-action" title={t("table.preview", { name })} aria-label={t("table.preview", { name })} onClick={() => setOpen(true)}><Table2 size={14} /></button>
    {open && <TableDialog title={name} returnFocus={trigger.current} onClose={() => setOpen(false)}><TableFileContent key={`${message.threadId}:${message.messageId}:${path}`} path={path} name={name} message={message} delimiter={delimiter} /></TableDialog>}
  </>;
}

function TableFileContent({ path, name, message, delimiter }: {
  path: string; name: string; message: MessageAttachmentContext; delimiter: "," | "\t";
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
      } catch (reason) { fail(reason instanceof Error && reason.message === "size" ? "size" : "load"); }
    })();
    return () => { controller.abort(); worker?.terminate(); };
  }, [path, message.threadId, message.messageId, delimiter, attempt]);
  const data = useMemo(() => table && ({ columns: table.headers.map((text) => ({ text })), rows: table.rows.map((row) => row.map((text) => ({ text }))) }), [table]);
  if (error) return <div className="p-8 text-center text-sm"><p role="alert" className="mb-3 text-ink-secondary">{t(error === "size" ? "table.tooLarge" : error === "columns" || error === "format" ? "table.invalid" : "table.loadFailed")}</p><button type="button" className="rounded-lg border border-hairline px-3 py-2 hover:bg-raised" onClick={() => setAttempt(attempt + 1)}>{t("chat.retry")}</button></div>;
  if (!data) return <div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t("table.loading")}</div>;
  return <RichTable {...data} name={name} expanded />;
}
