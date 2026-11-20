import { createContext, useContext, useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { ChatCacheScope, readChatCache, writeChatCache } from "../lib/chat-cache";
import { noteRefusedRequest } from "../lib/session-ended";

// One budget per mounted conversation, shared by thumbnails and local Markdown previews.
export const ChatImagePreloads = createContext<Set<string> | null>(null);

export function preloadOnEntry(entries: Set<string> | null, src: string, version?: string) {
  if (!entries) return false;
  const id = imageId(src, version);
  if (entries.has(id)) return true;
  if (entries.size >= 3) return false;
  entries.add(id);
  return true;
}

export function isExternalImageSource(src: string): boolean {
  const value = src.trim();
  // The URL parser drops embedded ASCII tab/LF/CR and treats backslashes as slashes for special schemes.
  const networkSpelling = value.replace(/[\t\n\r]/g, "").replace(/\\/g, "/");
  // Chromium canonicalizes special-scheme variants (`https:host/x`, `https:/host/x`, backslashes) into network
  // requests.
  return networkSpelling.startsWith("//") || /^https?:/i.test(networkSpelling);
}

function imageId(src: string, version?: string) {
  // A remote image can appear at different message offsets and still have the same source.
  return JSON.stringify(version && isExternalImageSource(version) ? [version, null] : [src, version]);
}

const downloads = new Map<string, Promise<Blob>>();

function image(scope: string, src: string, version?: string) {
  const key = JSON.stringify([scope, imageId(src, version)]);
  const pending = downloads.get(key);
  if (pending) return pending;
  const request = (async () => {
    const cached = await readChatCache("images", scope, key);
    if (cached) return cached;
    const external = isExternalImageSource(src);
    const response = external ? await fetch(src, { credentials: "omit", referrerPolicy: "no-referrer" }) : await fetch(src);
    if (!response.ok) {
      if (!external && (response.status === 401 || response.status === 403)) noteRefusedRequest();
      throw new Error(String(response.status));
    }
    const blob = await response.blob();
    await writeChatCache("images", scope, key, blob);
    return blob;
  })().finally(() => downloads.delete(key));
  downloads.set(key, request);
  return request;
}

export function CachedChatImage({ src, version, ...props }: ImgHTMLAttributes<HTMLImageElement> & { version?: string }) {
  const scope = useContext(ChatCacheScope);
  const entries = useContext(ChatImagePreloads);
  const key = scope && src && (isExternalImageSource(src) || /^\/api\/(?:attachments\/[\w.-]+$|threads\/[\w-]+\/messages\/[\w-]+\/(?:image$|file\?preview=1&ref=\d+$))/.test(src))
    ? JSON.stringify([scope, src, version]) : null;
  const element = useRef<HTMLImageElement>(null);
  const [result, setResult] = useState<{ key: string; url: string }>();
  useEffect(() => {
    if (!key || !src || !scope) return;
    let alive = true;
    let url: string | undefined;
    const start = () => {
      void image(scope, src, version).then(blob => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setResult({ key, url });
      }, () => {
        if (!alive) return;
        if (isExternalImageSource(src)) setResult({ key, url: src });
        else element.current?.dispatchEvent(new Event("error"));
      });
    };
    let observer: IntersectionObserver | undefined;
    if (!preloadOnEntry(entries, src, version) && props.loading === "lazy" && element.current && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); start(); }
      }, { rootMargin: "1000px" });
      observer.observe(element.current.parentElement ?? element.current);
    } else start();
    return () => {
      observer?.disconnect();
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [key, src, scope, version, props.loading, entries]);
  const displaySrc = key ? result?.key === key ? result.url : undefined : src;
  return <img {...props} ref={element} referrerPolicy={src && isExternalImageSource(src) ? "no-referrer" : props.referrerPolicy} src={displaySrc}
    style={displaySrc ? props.style : { ...props.style, visibility: "hidden" }} />;
}
