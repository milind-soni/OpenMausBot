import { createContext, useContext, useEffect, useRef, useState, type ImgHTMLAttributes } from "react";

export const ImageCacheScope = createContext<string | null>(null);
const lifetime = 2 * 60 * 60 * 1000;
type Entry = { key: string; saved: number; blob: Blob; etag: string | null };
let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("mausbot-chat-images", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("images", { keyPath: "key" }).createIndex("saved", "saved");
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); database = undefined; };
        const expired = db.transaction("images", "readwrite").objectStore("images")
          .index("saved").openCursor(IDBKeyRange.upperBound(Date.now() - lifetime));
        expired.onsuccess = () => {
          const cursor = expired.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
        resolve(db);
      };
    }).catch(error => { database = undefined; throw error; });
  }
  return database;
}

type Listener = (blob: Blob | null) => void;
type Job = { listeners: Set<Listener>; current?: Blob };
const pending = new Map<string, Job>();

async function load(key: string, src: string, job: Job, localOwner: boolean) {
  const publish = (blob: Blob | null) => {
    job.current = blob ?? undefined;
    for (const listener of job.listeners) listener(blob);
  };
  const db = await openDatabase().catch(() => null);
  const record = db && await new Promise<Entry | undefined>(resolve => {
    const request = db.transaction("images").objectStore("images").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
  const fresh = record && Date.now() - record.saved < lifetime;
  if (fresh && localOwner) publish(record.blob);
  try {
    const response = await fetch(src, {
      cache: "no-store",
      headers: fresh && record.etag ? { "If-None-Match": record.etag } : {},
    });
    if (response.status === 304 && fresh) {
      if (!job.current) publish(record.blob);
      return;
    }
    if (!response.ok) {
      if ([401, 403, 404, 410].includes(response.status)) {
        db?.transaction("images", "readwrite").objectStore("images").delete(key);
        publish(null);
      } else if (!job.current) publish(null);
      return;
    }
    const blob = await response.blob();
    publish(blob);
    if (db) await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("images", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.objectStore("images").put({ key, saved: Date.now(), blob, etag: response.headers.get("etag") } satisfies Entry);
    });
  } catch {
    if (!job.current) publish(null);
  }
}

export function CachedChatImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const scope = useContext(ImageCacheScope);
  const key = scope && src && /^\/api\/(?:attachments\/[\w.-]+$|threads\/[\w-]+\/messages\/[\w-]+\/(?:image$|file\?preview=1&ref=\d+$))/.test(src)
    && typeof indexedDB !== "undefined" ? JSON.stringify([scope, src]) : null;
  const element = useRef<HTMLImageElement>(null);
  const [result, setResult] = useState<{ key: string; url: string }>();
  useEffect(() => {
    if (!key || !src) return;
    let url: string | undefined;
    let job: Job | undefined;
    const listener: Listener = blob => {
      if (url) URL.revokeObjectURL(url);
      url = blob ? URL.createObjectURL(blob) : undefined;
      setResult({ key, url: url ?? src });
    };
    const start = () => {
      job = pending.get(key);
      if (!job) {
        job = { listeners: new Set([listener]) };
        pending.set(key, job);
        const active = job;
        void load(key, src, active, scope === "loopback").catch(() => {
          for (const notify of active.listeners) notify(null);
        }).finally(() => pending.delete(key));
      } else {
        job.listeners.add(listener);
        if (job.current) listener(job.current);
      }
    };
    let observer: IntersectionObserver | undefined;
    if (props.loading === "lazy" && element.current && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); start(); }
      }, { rootMargin: "320px" });
      observer.observe(element.current.parentElement ?? element.current);
    } else start();
    return () => {
      observer?.disconnect();
      job?.listeners.delete(listener);
      if (url) URL.revokeObjectURL(url);
    };
  }, [key, src, scope, props.loading]);
  const displaySrc = key ? result?.key === key ? result.url : undefined : src;
  return <img {...props} ref={element} src={displaySrc}
    style={displaySrc ? props.style : { ...props.style, visibility: "hidden" }} />;
}
