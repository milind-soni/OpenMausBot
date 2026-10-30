// Plain ESM so Electron's main process and the server enforce exactly the same lease protocol.
export {
  acquireDataDirLease,
  acquireDataDirLeaseForProcess,
  clearRecordsFromOtherMachines,
  DataDirLeaseError,
} from "../electron/data-dir-lease.mjs";

export type {
  DataDirLease,
  DelegatedDataDirLease,
  OwnedDataDirLease,
} from "../electron/data-dir-lease.mjs";
