/** Public, write-only-secret view of a bot's external memory connection. */
export interface HindsightConfigView {
  enabled: boolean;
  baseUrl: string;
  bankId: string;
  apiKeyConfigured: boolean;
}

export interface HindsightOperationStatus {
  ok: boolean;
  at: string;
  message?: string;
}

export interface HindsightView extends HindsightConfigView {
  connection?: HindsightOperationStatus;
  recall?: HindsightOperationStatus;
  retain?: HindsightOperationStatus;
}
