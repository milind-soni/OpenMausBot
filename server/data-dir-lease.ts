// Plain ESM so Electron's main process and the server enforce exactly the same lease protocol.
import type { DataDirLease } from "../electron/data-dir-lease.mjs";

export {
  acquireDataDirLease,
  acquireDataDirLeaseForProcess,
  clearRecordsFromEarlierRunOfThisContainer,
  clearRecordsFromOtherMachines,
  DataDirLeaseError,
  describeDataDirLease,
} from "../electron/data-dir-lease.mjs";

export type {
  DataDirLease,
  DataDirLeaseHolder,
  DelegatedDataDirLease,
  OwnedDataDirLease,
} from "../electron/data-dir-lease.mjs";

/** The server's release for every exit path (process exit, graceful close, crash guard): the first call releases, later
 * calls do nothing, and a failure is logged, never thrown, so exiting is never stopped by the lease. */
export function releaseOnceAtExit(lease: Pick<DataDirLease, "release">): () => void {
  let attempted = false;
  return () => {
    if (attempted) return;
    attempted = true;
    try {
      lease.release();
    } catch (error) {
      console.error(`[data-directory] lease release failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
