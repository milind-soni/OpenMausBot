import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { listenLiveFrames } from "@/lib/live-events";
import type { MapComputer, MapComputersPayload } from "../../shared/map-computer";
import type { TeamComputers } from "./team-canvas-computers";

export const MAP_COMPUTERS_POLL_MS = 2_000;

export interface ShownFrame {
  url: string;
  /** This browser's clock: when the frame was captured. */
  at: number;
  version: string;
}

/** The computer a bot's live frames belong to: its own, else the shared one it uses. */
export function computerForBot(computers: readonly MapComputer[], botId: string): MapComputer | undefined {
  return computers.find((computer) => computer.kind === "bot" && computer.id === botId)
    ?? computers.find((computer) => computer.kind === "team" && computer.botIds.includes(botId));
}

export function teamComputersFor(sectionKey: string, botIds: readonly string[], computers: readonly MapComputer[]): TeamComputers {
  const ids = new Set(botIds);
  const team = computers.find((computer) => computer.kind === "team" && computer.section === sectionKey);
  return {
    own: new Map(computers.filter((computer) => computer.kind === "bot" && ids.has(computer.id)).map((computer) => [computer.id, computer.id])),
    ...(team ? { team: { id: team.id, botIds: team.botIds.filter((id) => ids.has(id)) } } : {}),
  };
}

export function haveParam(frames: Readonly<Record<string, ShownFrame>>): string {
  return Object.entries(frames).map(([id, frame]) => `${id}:${frame.version}`).join(",");
}

/** Server time to this browser's time, by the frame's age when the server answered. */
export function localFrameTime(frameAt: number, serverNow: number, receivedAt: number): number {
  return receivedAt - Math.max(0, serverNow - frameAt);
}

function frameBlob(data: string, mime: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

/**
 * The Team map's computers and their newest screens, while `enabled`: the server's list every two seconds (which also
 * keeps it capturing small frames of running machines), plus the frames bots' own turns send on the event stream.
 */
export function useMapComputers(enabled: boolean) {
  const [payload, setPayload] = useState<MapComputersPayload | null>(null);
  const [frames, setFrames] = useState<Record<string, ShownFrame>>({});
  const [error, setError] = useState<string | null>(null);
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const computersRef = useRef<MapComputer[]>([]);
  computersRef.current = payload?.computers ?? [];
  const retired = useRef(new Set<string>());
  const mounted = useRef(true);

  const show = useCallback(async (id: string, data: string, mime: string, at: number, version: string) => {
    if ((framesRef.current[id]?.at ?? -Infinity) >= at) return;
    let url: string;
    try {
      url = URL.createObjectURL(frameBlob(data, mime));
    } catch {
      return;
    }
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
    } catch {
      URL.revokeObjectURL(url);
      return;
    }
    if (!mounted.current || (framesRef.current[id]?.at ?? -Infinity) >= at) {
      URL.revokeObjectURL(url);
      return;
    }
    const previous = framesRef.current[id]?.url;
    framesRef.current = { ...framesRef.current, [id]: { url, at, version } };
    setFrames(framesRef.current);
    if (previous) {
      retired.current.add(previous);
      window.setTimeout(() => { URL.revokeObjectURL(previous); retired.current.delete(previous); }, 2_000);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const frame of Object.values(framesRef.current)) URL.revokeObjectURL(frame.url);
      for (const url of retired.current) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let inFlight = false;
    const poll = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const have = haveParam(framesRef.current);
        const next: MapComputersPayload = await api(`/api/computers/frames${have ? `?have=${encodeURIComponent(have)}` : ""}`, { signal: AbortSignal.timeout(30_000) });
        if (stopped) return;
        const receivedAt = Date.now();
        setPayload(next);
        setError(null);
        for (const computer of next.computers) {
          const frame = computer.frame;
          if (frame?.data) void show(computer.id, frame.data, frame.mime, localFrameTime(frame.at, next.now, receivedAt), frame.version);
        }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, MAP_COMPUTERS_POLL_MS);
    const stopListening = listenLiveFrames({
      onFrame: (frame) => {
        if (frame.kind !== "screen" || frame.surface !== "computer" || !frame.png) return;
        const computer = computerForBot(computersRef.current, frame.botId);
        if (computer) void show(computer.id, frame.png, frame.mime ?? "image/png", Date.now(), "live");
      },
    });
    return () => {
      stopped = true;
      window.clearInterval(timer);
      stopListening();
    };
  }, [enabled, show]);

  return { computers: payload?.computers ?? [], configured: payload?.configured ?? null, frames, error };
}

/** "Show computers", remembered per workspace like the canvas layout; until chosen, on whenever there is a computer to
 * show. `loaded` turns true once the saved choice has been read, so a hidden map never starts watching on load. */
export function useShowComputers(defaultOn: boolean): { show: boolean; loaded: boolean; choose: (on: boolean) => void } {
  const [key, setKey] = useState<string | null>(null);
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void api("/.well-known/openmausbot/environment", { signal: AbortSignal.timeout(5_000) }).then((environment) => {
      if (!active || typeof environment.environmentId !== "string") return;
      const storageKey = `omb-team-canvas:${environment.environmentId}:computers`;
      setKey(storageKey);
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved === "on" || saved === "off") setChosen(saved === "on");
      } catch {}
    }).catch(() => {}).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);
  const choose = useCallback((on: boolean) => {
    setChosen(on);
    if (!key) return;
    try { localStorage.setItem(key, on ? "on" : "off"); } catch {}
  }, [key]);
  return { show: chosen ?? defaultOn, loaded, choose };
}
