export interface ManagedDesktopState {
  status: "signed-out" | "connecting" | "connected" | "reauth-required" | "unavailable";
  message?: string;
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
  cancelEnrollment(): Promise<ManagedDesktopState>;
  refresh(): Promise<ManagedDesktopState>;
  disconnect(): Promise<ManagedDesktopState>;
  onState(callback: (state: ManagedDesktopState) => void): () => void;
}
export function managedPortalOrigin(value: string): string;
