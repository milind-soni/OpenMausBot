export type UpdatesConsentStatus = "opted_in" | "declined" | "withdrawn";
export declare const UPDATES_CONSENT_VERSION: string;
export declare const UPDATES_CONSENT_STATUSES: readonly UpdatesConsentStatus[];
export interface UpdatesConsentRecord {
  status: UpdatesConsentStatus; version: string; at: number;
  account?: string; email?: string; receipt?: string; pending?: true;
}
export declare function parseUpdatesConsent(value: unknown): UpdatesConsentRecord | null;
export declare function parseAccountConsent(result: unknown): { status: UpdatesConsentStatus; textVersion: string } | null;
/** What a page needs to ask "Get MausBot updates?" once, and to show the Settings switch. */
export interface UpdatesConsentState {
  /** False in a branded build or where this app has no MausBot Cloud sign-in: nothing is asked or shown. */
  available: boolean;
  /** No answer on this computer, and the signed-in account (if any) has none either. */
  due: boolean;
  status: UpdatesConsentStatus | null;
  signedIn: boolean;
  /** Where the emails go: the account's address, or the one typed here while signed out. */
  email: string | null;
  version: string;
}
/** On this computer's page and My Cloud's own page in this app's window. */
export interface UpdatesConsentBridge {
  state(): Promise<UpdatesConsentState>;
  /** `email`: only while signed out, and optional then. */
  choose(choice: { status: UpdatesConsentStatus; email?: string }): Promise<UpdatesConsentState>;
}
export interface UpdatesConsent extends UpdatesConsentBridge {
  /** Sends an answer the Admin has not recorded yet, or carries this computer's answer over to a signed-in account. */
  sync(): Promise<void>;
  /** Called with each Cloud account state: a newly signed-in account is synced at once. */
  accountChanged(state: import("./cloud-account.mjs").CloudAccountState | null | undefined): void;
}
export type UpdatesConsentClient = Pick<import("./cloud-account.mjs").CloudAccountClient, "state" | "updatesConsent" | "recordUpdatesConsent" | "updatesConsentByEmail" | "withdrawUpdatesConsent">;
export declare function createUpdatesConsent(options: {
  prefs: { installId(): string; updatesConsent(): UpdatesConsentRecord | null; setUpdatesConsent(value: unknown): boolean };
  account(): UpdatesConsentClient | null;
  available(): boolean | Promise<boolean>;
  now?: () => number;
  onChange?: () => void;
}): UpdatesConsent;
export declare function registerUpdatesConsent(options: {
  ipcMain: { handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void };
  page(event: unknown): "local" | "cloud" | "server" | null;
  consent: UpdatesConsentBridge;
}): void;
