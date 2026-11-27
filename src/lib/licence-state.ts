// A server install's licence as its admins' Settings shows it (GET /api/license, owner or admin only): the licence card
// and the seat banner. A desktop and a Cloud home answer `files: false` and show neither.
import { useEffect, useState } from "react";
import { api } from "@/state/api";

export interface LicenceState {
  valid: boolean;
  source: "file" | "env" | "last-good" | null;
  plan: string | null;
  seats: number | null;
  expiresAt: string | null;
  expiresInDays: number | null;
  graceEndsAt: string | null;
  graceDaysLeft: number | null;
  /** How many people can sign in now (server/routes/seats.ts). */
  seatsUsed: number | null;
  /** This server reads licence files: false on a desktop and a Cloud home. */
  files: boolean;
  /** The licence in force came from MausBot through the connector, which still reads it. */
  connected: boolean;
}

/** Saving the sign-in list changes the seat count: Settings reads the licence again. */
export const LICENCE_CHANGED = "omb-licence-changed";

export function readLicenceState(value: unknown): LicenceState | null {
  if (!value || typeof value !== "object") return null;
  const said = value as Partial<LicenceState>;
  if (typeof said.valid !== "boolean" || said.files !== true) return null;
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);
  const text = (s: unknown) => (typeof s === "string" && s ? s : null);
  return {
    valid: said.valid,
    source: said.source === "file" || said.source === "env" || said.source === "last-good" ? said.source : null,
    plan: text(said.plan), seats: count(said.seats), expiresAt: text(said.expiresAt), expiresInDays: count(said.expiresInDays),
    graceEndsAt: text(said.graceEndsAt), graceDaysLeft: count(said.graceDaysLeft), seatsUsed: count(said.seatsUsed),
    files: true, connected: said.connected === true,
  };
}

/** Over the plan's seats: invites are refused until seats are added. Only while the licence is in force. */
export function overSeats(state: LicenceState | null): { used: number; seats: number } | null {
  if (!state?.valid || state.seats === null || state.seatsUsed === null || state.seatsUsed <= state.seats) return null;
  return { used: state.seatsUsed, seats: state.seats };
}

/** The licence of the server this page belongs to, read when `enabled` (an admin on a server's page) and again after the
 * sign-in list changes; null until read, and for anyone else. */
export function useLicenceState(enabled: boolean): LicenceState | null {
  const [state, setState] = useState<LicenceState | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const again = () => setRound((value) => value + 1);
    window.addEventListener(LICENCE_CHANGED, again);
    return () => window.removeEventListener(LICENCE_CHANGED, again);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let live = true;
    void api("/api/license", { background: true }).then((value) => { if (live) setState(readLicenceState(value)); }).catch(() => { if (live) setState(null); });
    return () => { live = false; };
  }, [enabled, round]);
  return state;
}
