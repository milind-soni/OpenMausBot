import { useSyncExternalStore } from "react";

export type OtechPlanType = "trial" | "local" | "cloud";
export type OtechLicenseStatus = "unlicensed" | "active" | "grace_period" | "expired" | "revoked";

export interface OtechLicenseState {
  status: OtechLicenseStatus;
  plan: OtechPlanType | null;
  key: string | null;
  customer?: string;
  phone?: string;
  shop?: string;
  activatedAt?: string;
  expiresAt?: string;
  lastVerifiedAt?: string;
  isTrial?: boolean;
  trialStartedAt?: string;
  trialExpiresAt?: string;
  offlineGraceUntil?: string;
  error?: string;
}

const STORAGE_KEY = "otech-license-data";
const TRIAL_HISTORY_KEY = "otech-trial-history";
const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days grace period
const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days trial

// Built-in offline fallback database for known keys & development/offline evaluation
const OFFLINE_KEYS_DB: Record<string, { plan: OtechPlanType; customer: string; phone: string; shop: string; expiresAt: string; revoked?: boolean }> = {
  "OTECH-JO-CLD8-5W3X": {
    plan: "cloud",
    customer: "شركة الأفق للاستشارات",
    phone: "+962790001122",
    shop: "المقر الرئيسي",
    expiresAt: "2027-12-31T23:59:59.000Z",
    revoked: true,
  },
};

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function getStoredLicense(): OtechLicenseState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { status: "unlicensed", plan: null, key: null };
    const parsed: OtechLicenseState = JSON.parse(raw);

    // Validate expiration for trial
    if (parsed.isTrial && parsed.trialExpiresAt) {
      if (new Date(parsed.trialExpiresAt).getTime() < Date.now()) {
        parsed.status = "expired";
      }
    }
    // Validate expiration for license
    else if (parsed.key && parsed.expiresAt) {
      if (new Date(parsed.expiresAt).getTime() < Date.now()) {
        parsed.status = "expired";
      } else if (parsed.lastVerifiedAt) {
        // Check offline grace period (3 days)
        const lastVerified = new Date(parsed.lastVerifiedAt).getTime();
        const now = Date.now();
        if (now - lastVerified > GRACE_PERIOD_MS) {
          // If past 3 days and hasn't re-verified
          parsed.status = "grace_period";
          parsed.offlineGraceUntil = new Date(lastVerified + GRACE_PERIOD_MS).toISOString();
        }
      }
    }
    return parsed;
  } catch {
    return { status: "unlicensed", plan: null, key: null };
  }
}

function saveLicense(state: OtechLicenseState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error("Failed to save license state", err);
  }
  notify();
}

let cachedState: OtechLicenseState | null = null;

function getSnapshot(): OtechLicenseState {
  if (!cachedState) {
    cachedState = getStoredLicense();
  }
  return cachedState;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Verifies a key against https://license.otech.jo/api/verify
 * Falls back to offline keys or 3-day grace period if network unavailable
 */
export async function verifyLicenseKey(keyToVerify: string): Promise<{ success: boolean; state: OtechLicenseState; message?: string }> {
  const normalizedKey = keyToVerify.trim().toUpperCase();

  // Try online verification first
  let onlineResult: any = null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(`https://license.otech.jo/api/verify?key=${encodeURIComponent(normalizedKey)}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (resp.ok) {
      onlineResult = await resp.json();
    }
  } catch (err) {
    // Network offline or timeout - will fall back to local/grace logic
    console.warn("Online license verification failed or timed out, trying offline fallback...", err);
  }

  const now = new Date();

  if (onlineResult) {
    if (onlineResult.valid) {
      const newState: OtechLicenseState = {
        status: "active",
        plan: onlineResult.plan || "local",
        key: normalizedKey,
        customer: onlineResult.customer,
        phone: onlineResult.phone,
        shop: onlineResult.shop,
        activatedAt: now.toISOString(),
        expiresAt: onlineResult.expiresAt,
        lastVerifiedAt: now.toISOString(),
        isTrial: false,
      };
      cachedState = newState;
      saveLicense(newState);
      return { success: true, state: newState };
    } else if (onlineResult.reason === "expired") {
      const expiredState: OtechLicenseState = {
        status: "expired",
        plan: onlineResult.plan || "local",
        key: normalizedKey,
        customer: onlineResult.customer,
        phone: onlineResult.phone,
        expiresAt: onlineResult.expiresAt,
        lastVerifiedAt: now.toISOString(),
        isTrial: false,
      };
      cachedState = expiredState;
      saveLicense(expiredState);
      return { success: false, state: expiredState, message: "License key has expired" };
    } else if (onlineResult.reason === "revoked") {
      const revokedState: OtechLicenseState = {
        status: "revoked",
        plan: null,
        key: normalizedKey,
        lastVerifiedAt: now.toISOString(),
      };
      cachedState = revokedState;
      saveLicense(revokedState);
      return { success: false, state: revokedState, message: "License key has been revoked" };
    } else {
      return {
        success: false,
        state: cachedState ?? { status: "unlicensed", plan: null, key: null },
        message: onlineResult.error || "Invalid license key",
      };
    }
  }

  // Offline Fallback Check
  const localEntry = OFFLINE_KEYS_DB[normalizedKey];
  if (localEntry) {
    if (localEntry.revoked) {
      const revokedState: OtechLicenseState = {
        status: "revoked",
        plan: null,
        key: normalizedKey,
      };
      cachedState = revokedState;
      saveLicense(revokedState);
      return { success: false, state: revokedState, message: "License key has been revoked" };
    }

    const expiresAtDate = new Date(localEntry.expiresAt);
    if (expiresAtDate < now) {
      const expiredState: OtechLicenseState = {
        status: "expired",
        plan: localEntry.plan,
        key: normalizedKey,
        customer: localEntry.customer,
        phone: localEntry.phone,
        shop: localEntry.shop,
        expiresAt: localEntry.expiresAt,
        lastVerifiedAt: now.toISOString(),
        isTrial: false,
      };
      cachedState = expiredState;
      saveLicense(expiredState);
      return { success: false, state: expiredState, message: "License key has expired" };
    }

    const newState: OtechLicenseState = {
      status: "active",
      plan: localEntry.plan,
      key: normalizedKey,
      customer: localEntry.customer,
      phone: localEntry.phone,
      shop: localEntry.shop,
      activatedAt: now.toISOString(),
      expiresAt: localEntry.expiresAt,
      lastVerifiedAt: now.toISOString(),
      isTrial: false,
    };
    cachedState = newState;
    saveLicense(newState);
    return { success: true, state: newState };
  }

  // If key matches nothing
  return {
    success: false,
    state: cachedState ?? { status: "unlicensed", plan: null, key: null },
    message: "Invalid license key format or key not recognized",
  };
}

/**
 * Starts 7-day free trial
 */
export function startOtechTrial(): { success: boolean; state: OtechLicenseState; message?: string } {
  try {
    const history = localStorage.getItem(TRIAL_HISTORY_KEY);
    if (history) {
      const parsed = JSON.parse(history);
      if (parsed.startedAt && Date.now() - new Date(parsed.startedAt).getTime() > TRIAL_DURATION_MS) {
        return {
          success: false,
          state: { status: "expired", plan: "trial", key: null, isTrial: true },
          message: "Free trial has already been used on this device",
        };
      }
    }
  } catch {
    // Continue
  }

  const now = new Date();
  const trialExpires = new Date(now.getTime() + TRIAL_DURATION_MS);

  const trialState: OtechLicenseState = {
    status: "active",
    plan: "trial",
    key: null,
    isTrial: true,
    trialStartedAt: now.toISOString(),
    trialExpiresAt: trialExpires.toISOString(),
    activatedAt: now.toISOString(),
  };

  try {
    localStorage.setItem(TRIAL_HISTORY_KEY, JSON.stringify({ startedAt: now.toISOString() }));
  } catch {}

  cachedState = trialState;
  saveLicense(trialState);
  return { success: true, state: trialState };
}

export function clearOtechLicense(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  cachedState = { status: "unlicensed", plan: null, key: null };
  notify();
}

/**
 * React hook for OTECH License state
 */
export function useOtechLicense() {
  const license = useSyncExternalStore(subscribe, getSnapshot, () => ({ status: "unlicensed", plan: null, key: null } as OtechLicenseState));

  // Determine if app is locked:
  // App is locked if unlicensed, expired, revoked, or grace period exceeded
  const isLocked = license.status === "unlicensed" || license.status === "expired" || license.status === "revoked";

  return {
    license,
    isLocked,
    plan: license.plan,
    isTrial: Boolean(license.isTrial),
    activateKey: async (key: string) => {
      const res = await verifyLicenseKey(key);
      cachedState = res.state;
      notify();
      return res;
    },
    startTrial: () => {
      const res = startOtechTrial();
      cachedState = res.state;
      notify();
      return res;
    },
    clearLicense: () => {
      clearOtechLicense();
    },
  };
}
