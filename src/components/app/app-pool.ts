// When the pool is full, the frame seen least recently is torn down first and only then does the new one
// mount, so the count of live frames never goes over.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export const APP_POOL_LIMITS = {
  live: 3,
  /** A row this close to the viewport counts as visible (px). */
  marginPx: 300,
  /** Only this many of a thread's newest app rows mount by themselves. */
  autoMountNewest: 20,
} as const;

export interface AppPoolMember {
  evict(): Promise<void>;
}

interface Slot {
  member: AppPoolMember;
  visible: boolean;
  /** When the row was last in view: now while it is, else when it left. */
  seenAt: number;
}

export interface AppPool {
  /** Resolves once there is room, or false when the request was withdrawn. */
  acquire(key: string, member: AppPoolMember): Promise<boolean>;
  seen(key: string, visible: boolean): void;
  release(key: string): void;
  live(): string[];
}

export function createAppPool(options: { limit?: number; now?: () => number } = {}): AppPool {
  const limit = Math.max(1, options.limit ?? APP_POOL_LIMITS.live);
  const now = options.now ?? (() => Date.now());
  const slots = new Map<string, Slot>();
  const waiting: Array<{ key: string; member: AppPoolMember; resolve(granted: boolean): void }> = [];
  /** Keys being torn down to make room: they still count. */
  const leaving = new Set<string>();
  const visibility = new Map<string, { visible: boolean; at: number }>();

  /** The slot to give up: a row out of view, the one that left it longest
   * ago; else the visible one that came into view first. */
  const victim = (except: ReadonlySet<string>): string | undefined => {
    let best: string | undefined;
    let bestScore = Infinity;
    for (const [key, slot] of slots) {
      if (except.has(key) || leaving.has(key)) continue;
      const score = (slot.visible ? 1e15 : 0) + slot.seenAt;
      if (score < bestScore) { best = key; bestScore = score; }
    }
    return best;
  };

  const pump = () => {
    // Grant while there is room. A frame being torn down still holds its slot.
    while (waiting.length && slots.size < limit) {
      const next = waiting.shift()!;
      const seen = visibility.get(next.key);
      slots.set(next.key, { member: next.member, visible: seen?.visible ?? true, seenAt: seen?.at ?? now() });
      next.resolve(true);
    }
    // Make room: one teardown per waiting request not already covered by one.
    const asking = new Set(waiting.map((entry) => entry.key));
    for (let needed = waiting.length - leaving.size; needed > 0; needed -= 1) {
      const key = victim(asking);
      if (!key) break;
      leaving.add(key);
      void slots.get(key)!.member.evict().catch(() => {}).finally(() => {
        leaving.delete(key);
        slots.delete(key);
        pump();
      });
    }
  };

  return {
    acquire(key, member) {
      if (slots.has(key) && !leaving.has(key)) {
        slots.get(key)!.member = member;
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const existing = waiting.findIndex((entry) => entry.key === key);
        if (existing !== -1) waiting.splice(existing, 1)[0]!.resolve(false);
        waiting.push({ key, member, resolve });
        pump();
      });
    },
    seen(key, visible) {
      const at = now();
      visibility.set(key, { visible, at });
      const slot = slots.get(key);
      if (slot) { slot.visible = visible; slot.seenAt = at; }
    },
    release(key) {
      const index = waiting.findIndex((entry) => entry.key === key);
      if (index !== -1) waiting.splice(index, 1)[0]!.resolve(false);
      visibility.delete(key);
      if (leaving.has(key)) return;
      if (slots.delete(key)) pump();
    },
    live: () => [...slots.keys()],
  };
}

export const appPool: AppPool = createAppPool();

/** `auto` rows ask for a frame each time they come into view; the others only when the person asks (`open`). */
export function useAppPoolSlot(args: {
  key: string;
  target: RefObject<HTMLElement | null>;
  auto: boolean;
  evict(): Promise<void>;
  pool?: AppPool;
}): { live: boolean; open(): void; close(): void } {
  const pool = args.pool ?? appPool;
  const { key, target, auto } = args;
  const [live, setLive] = useState(false);
  const evictRef = useRef(args.evict);
  evictRef.current = args.evict;
  const member = useRef<AppPoolMember>({
    evict: async () => {
      await evictRef.current();
      setLive(false);
    },
  });
  const request = useRef(0);

  const open = useCallback(() => {
    const ask = ++request.current;
    void pool.acquire(key, member.current).then((granted) => {
      if (granted && ask === request.current) setLive(true);
    });
  }, [pool, key]);

  const close = useCallback(() => {
    request.current += 1;
    pool.release(key);
    setLive(false);
  }, [pool, key]);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    // Without IntersectionObserver the row counts as in view.
    if (typeof IntersectionObserver === "undefined") {
      pool.seen(key, true);
      if (auto) open();
      return;
    }
    let wasVisible = false;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      pool.seen(key, visible);
      // Ask on the way in only: a frame torn down while in view (the pool
      // needed its slot) waits for the next time it is scrolled to.
      if (visible && !wasVisible && auto) open();
      wasVisible = visible;
    }, { rootMargin: `${APP_POOL_LIMITS.marginPx}px 0px` });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pool, key, target, auto, open]);

  useEffect(() => () => {
    request.current += 1;
    pool.release(key);
  }, [pool, key]);

  return { live, open, close };
}
