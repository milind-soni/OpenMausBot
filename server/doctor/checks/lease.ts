// The data folder's lease (electron/data-dir-lease.mjs): which process may use the folder. A lease a dead process of
// this machine left is retired by taking the lease, with the lease module's own recovery, which the runner does before
// any other fix (run.ts); a live one means the server is running, and no fix runs beside it.
import { describeDataDirLease, type DataDirLeaseHolder } from "../../data-dir-lease.ts";
import type { DoctorCheck } from "../types.ts";

export function leaseCheck(describe: (dataDir: string) => DataDirLeaseHolder = describeDataDirLease): DoctorCheck {
  return {
    id: "lease",
    title: "Data folder lease",
    looksAt: "openmausbot-server.lease",
    check(ctx) {
      if (ctx.mode === "start") return { status: "ok", summary: "This server holds it." };
      const holder = describe(ctx.dataDir);
      switch (holder.state) {
        case "none":
          return { status: "ok", summary: "No server is using the data folder.", detail: holder };
        case "alive":
          return { status: "ok", summary: `A server is using the data folder (process ${holder.pid}).`, detail: holder };
        case "dead":
          return { status: "problem", fixable: true, detail: holder,
            summary: `Process ${holder.pid}, which is no longer running, left its lease on the data folder.` };
        case "other-machine":
          return { status: "problem", detail: holder,
            summary: `The lease names a process on another machine or container (${holder.host}, process ${holder.pid}).`,
            instruction: `If no OpenMausBot runs there on this folder, stop this server and delete ${holder.path}; it starts again without it.` };
        default:
          return { status: "problem", detail: holder, summary: "The lease record cannot be read.",
            instruction: `If no OpenMausBot is running on this folder, delete ${holder.path} and start the server again.` };
      }
    },
  };
}
