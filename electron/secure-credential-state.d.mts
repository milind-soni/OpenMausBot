// Types for secure-credential-state.mjs as the headless server uses it
// (server/tunnel.ts). Keep in step with the implementation.
export type CredentialDocument = Record<string, unknown>;

export interface SecureCredentialState {
  read(): CredentialDocument;
  update(
    derive: (current: CredentialDocument) => CredentialDocument,
    afterPersist?: (next: CredentialDocument) => Promise<void> | void,
  ): Promise<unknown>;
}

export declare function createSecureCredentialState(
  initialCredentials: CredentialDocument,
  persist: (next: CredentialDocument) => Promise<void> | void,
  options?: { writable?: boolean },
): SecureCredentialState;
