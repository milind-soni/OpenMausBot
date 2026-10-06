import type { SecureCredentialState } from "./secure-credential-state.mjs";
export declare const INKBOX_SECRET_REQUEST: "openmausbot:inkbox-secret:request";
export declare const INKBOX_SECRET_RESPONSE: "openmausbot:inkbox-secret:response";
export declare const INKBOX_STORAGE_ERROR: "Secure Inkbox storage is unavailable.";
export declare function validInkboxSecretDocument(value: unknown): boolean;
export declare function validInkboxRequestId(value: unknown): value is string;
export interface InkboxUtilityProcess { postMessage(message: object): void }
export declare function createInkboxCredentialBridge(options: {
  workspacePath: string;
  credentials: SecureCredentialState;
  isAvailable(): Promise<boolean>;
  isCurrent(proc: InkboxUtilityProcess): boolean;
}): { receive(proc: InkboxUtilityProcess, message: unknown): boolean };
