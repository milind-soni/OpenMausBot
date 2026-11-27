import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/state/store";
import {
  ALL_PHONE_APPS,
  PHONE_CAPABILITIES,
  type PhoneApps,
  type PhoneCapability,
  type PhoneGrant,
} from "../../shared/phone-apps";

export interface PublicPhone {
  key: string;
  registration: {
    installId: string;
    name: string;
    platform: "ios" | "android";
    appVersion: string;
    timeZone: string;
    /** Capability → the OS grant string; present means the phone allows it. */
    capabilities: Partial<Record<PhoneCapability, string>>;
  };
  registeredAt: number;
  seen: number;
  lastUsedAt: number | null;
  online: boolean;
  busy: boolean;
}

export interface PhoneAppRow {
  cap: PhoneCapability;
  grant: PhoneGrant | null;
  onPhone: boolean;
}

const PHONES_POLL_MS = 15_000;

/** Mirrors the server: an unset grant list means every app, for every bot. */
export function effectivePhoneApps(bot: { phoneApps?: PhoneApps }): PhoneApps {
  return bot.phoneApps ?? ALL_PHONE_APPS;
}

export function nextPhoneApps(
  bot: { phoneApps?: PhoneApps },
  cap: PhoneCapability,
  value: PhoneGrant | null,
): PhoneApps {
  const next: PhoneApps = { ...effectivePhoneApps(bot) };
  if (value) next[cap] = value;
  else delete next[cap];
  return next;
}

export function phoneAppRows(
  bot: { phoneApps?: PhoneApps },
  phones: PublicPhone[],
): PhoneAppRow[] {
  const apps = effectivePhoneApps(bot);
  return PHONE_CAPABILITIES.map((cap) => ({
    cap,
    grant: apps[cap] ?? null,
    onPhone: phones.some((phone) => Boolean(phone.registration.capabilities[cap])),
  }));
}

export function phoneNames(phones: PublicPhone[]): string {
  return phones.map((phone) => phone.registration.name).join(", ");
}

export function phoneAppChips(phone: PublicPhone): PhoneCapability[] {
  return PHONE_CAPABILITIES.filter((cap) => Boolean(phone.registration.capabilities[cap]));
}

export function phonePlatformLabel(platform: "ios" | "android"): string {
  return platform === "ios" ? "iPhone" : "Android";
}

export function phoneRemovePath(key: string): string {
  return `/api/phones/${encodeURIComponent(key)}`;
}

export function usePhones(): { phase: "loading" | "ready"; phones: PublicPhone[]; refresh(): void } {
  const [state, setState] = useState<{ phase: "loading" | "ready"; phones: PublicPhone[] }>({ phase: "loading", phones: [] });
  const disposed = useRef(false);

  const refresh = useCallback(() => {
    // A poll: never someone using a Cloud home, and never sent from a hidden page (src/state/api.ts `background`).
    void api<{ phones: PublicPhone[] }>("/api/phones", { background: true })
      .then((response) => {
        if (!disposed.current) setState({ phase: "ready", phones: response.phones ?? [] });
      })
      .catch(() => {
        // Keep the last list; a failed poll must not blank the card.
      });
  }, []);

  useEffect(() => {
    disposed.current = false;
    refresh();
    const timer = window.setInterval(refresh, PHONES_POLL_MS);
    return () => {
      disposed.current = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { ...state, refresh };
}
