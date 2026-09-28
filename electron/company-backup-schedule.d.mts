export interface CompanyBackupScheduleState {
  enabled: boolean;
  status: "off" | "waiting" | "running" | "paused" | "error";
  nextBackupAt?: number;
  lastAttemptAt?: number;
  lastBackupAt?: number;
  message?: string;
}
export interface CompanyBackupScheduleScope { key: string; generation: number; /** True for an older saved key form of this same scope; adopted, never forgotten. */ adopts?(savedKey: string): boolean; }
export function createCompanyBackupSchedule(options: {
  store: { read(): Promise<unknown>; write(value: unknown): Promise<void> };
  scope(): CompanyBackupScheduleScope | null;
  run(signal: AbortSignal, scope: CompanyBackupScheduleScope): Promise<unknown>;
  onState?(state: CompanyBackupScheduleState): void;
  now?(): number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): {
  state(): CompanyBackupScheduleState;
  start(): Promise<CompanyBackupScheduleState>;
  configure(input: { enabled: false } | { enabled: true; confirmation: "BACK UP THIS WORKSPACE DAILY" }): Promise<CompanyBackupScheduleState>;
  forget(): Promise<CompanyBackupScheduleState>;
  reconcile(): void;
  close(): void;
};
