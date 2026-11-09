// Share replay (server/routes/replay.ts): which conversation's dialog is open, its preview, the published link and the
// one-file download.
import { useSyncExternalStore } from "react";

import type { PublishedPageCard } from "../../shared/published-page";
import { api } from "@/state/api";

export interface ReplayPreviewStep {
  n: number;
  kind: "browser" | "tool";
  action: string;
  detail?: string;
  site?: string;
  ok: boolean;
  imageUrl: string | null;
  /** Its picture fits on the page as things stand. */
  pictured: boolean;
}

export interface ReplayPreview {
  jobs: Array<{ requestId: string; at: number; text: string }>;
  replay: { requestId: string; title: string; bot: string; request: string; answer: string; startedAt: number; endedAt: number; steps: ReplayPreviewStep[]; leftOutToFit: number };
}

export interface ReplayTarget { threadId: string; botId: string }

let open: ReplayTarget | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

export function openShareReplay(target: ReplayTarget): void {
  open = target;
  changed();
}

export function closeShareReplay(): void {
  open = null;
  changed();
}

export const shareReplayTarget = (): ReplayTarget | null => open;

export function useShareReplayTarget(): ReplayTarget | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, shareReplayTarget, () => null);
}

const base = (threadId: string) => `/api/threads/${encodeURIComponent(threadId)}/replay`;

export function loadReplay(threadId: string, request?: string): Promise<ReplayPreview> {
  return api<ReplayPreview>(`${base(threadId)}${request ? `?request=${encodeURIComponent(request)}` : ""}`, { timeoutMs: 20_000 });
}

export async function publishReplay(threadId: string, choice: { request: string; title: string; leaveOut: number[] }): Promise<PublishedPageCard> {
  const answer = await api<{ card: PublishedPageCard }>(`${base(threadId)}/publish`, { method: "POST", body: JSON.stringify(choice), timeoutMs: 120_000 });
  return answer.card;
}

/** The replay as one .html file, its pictures inside it. */
export async function downloadReplay(threadId: string, choice: { request: string; title: string; leaveOut: number[] }): Promise<void> {
  const query = new URLSearchParams({ request: choice.request, title: choice.title, leaveOut: choice.leaveOut.join(",") });
  const res = await fetch(`${base(threadId)}.html?${query}`);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(choice.title || "replay").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "replay"}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
