export interface ManagedDesktopState {
  /** license-expired: the organisation's Admin licence lapsed. Not a
   * revocation; the connection resumes by itself once it is renewed. */
  status: "signed-out" | "connecting" | "connected" | "reauth-required" | "unavailable" | "license-expired";
  message?: string;
  /** A sign-in attempt found the Admin's licence expired. */
  notice?: "license-expired";
  enrollment?: { userCode: string; verificationUri: string; expiresAt: number };
  organization?: { id: string; name: string };
  email?: string;
  deviceId?: string;
  expiresAt?: number;
  providers?: Array<{ id: string; configured: boolean; models: string[] }>;
  cloudBackups?: boolean;
  branding?: import("./organization-branding.mjs").OrganizationBranding;
}
export interface ManagedDesktopBridge {
  settingsOpened?(): Promise<boolean>;
  state(): Promise<ManagedDesktopState>;
  begin(input: { portalOrigin: string }): Promise<ManagedDesktopState>;
  /** Reopens the pending sign-in page; takes no address from the renderer. */
  reopen?(): Promise<ManagedDesktopState>;
  cancelEnrollment(): Promise<ManagedDesktopState>;
  refresh(): Promise<ManagedDesktopState>;
  disconnect(): Promise<ManagedDesktopState>;
  onState(callback: (state: ManagedDesktopState) => void): () => void;
}
export function managedPortalOrigin(value: string): string;
