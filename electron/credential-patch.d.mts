// Types for credential-patch.mjs as server tests use it. Keep in step with the implementation.
export type CredentialPatchOptions = { everyClaudeBot?: false; qwenKeyTarget?: { region: string; workspace: string } };

export declare const CREDENTIAL_PATCH: Record<string, (value: string, options?: CredentialPatchOptions) => Record<string, unknown>>;

export declare function credentialSaveError(status: number, body: unknown, t?: (key: string) => string): Error;
