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

export declare function clearRecordsFromOtherMachines(
  dataDir: string,
): { path: string; host: string; pid: number }[];

export declare function macMountIsLocal(dfOutput: string, mountTable: string): boolean;

export declare function inMacSyncedFolder(path: string, home: string): boolean;

export declare function clearRecordsFromEarlierRunOfThisContainer(
  dataDir: string,
): { path: string; host: string; pid: number }[];

export type DataDirLeaseHolder =
  | { state: "none" | "invalid"; path: string }
  | { state: "alive" | "dead" | "other-machine"; path: string; pid: number; host: string; createdAt: number };

export declare function describeDataDirLease(dataDir: string): DataDirLeaseHolder;
