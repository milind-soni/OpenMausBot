export interface DataDirLease {
  readonly ownerPid: number;
  readonly delegated: boolean;
  release(): boolean;
}

export interface OwnedDataDirLease extends DataDirLease {
  readonly delegated: false;
  utilityServerLeaseEnvironment(): Readonly<Record<string, string>>;
}

export interface DelegatedDataDirLease extends DataDirLease {
  readonly delegated: true;
}

export declare class DataDirLeaseError extends Error {
  override readonly name: "DataDirLeaseError";
}

export declare function acquireDataDirLease(
  dataDir: string,
  options?: { legacyDataDir?: string },
): OwnedDataDirLease;

export declare function acquireDataDirLeaseForProcess(
  dataDir: string,
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): OwnedDataDirLease | DelegatedDataDirLease;
